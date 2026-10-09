import { app, ipcMain } from 'electron';
import { broadcastToAllWindows } from '../utils/broadcast';
import { readMachines, writeMachines, cleanName } from '../services/machines/store';
import { startBridge, bridgeState, openPairingOffer, closePairingOffer, currentOffer, currentRequest, decidePairRequest, closeStreamsOf } from '../services/machines/bridge-server';
import { pairWithCode, candidatesFrom, unpairPeer, fetchFleet, fetchScreen, openStream, driveAgent } from '../services/machines/client';
import { createRemoteFleet, type RemoteFleet } from '../services/machines/remote-fleet';
import { fleetSource } from '../services/machines/fleet-source';
import { startStatusPolling, peerStatus, forgetStatus, pollNow } from '../services/machines/status';
import { formatCode } from '../services/machines/pairing';
import { detectTailscale, tailnetPeers, deviceName } from '../services/tailscale-status';
import type { MachinesView } from '../services/machines/types';

/**
 * Settings > Machines: name this machine, show a pairing code, pair with
 * another machine's, set what each paired machine may do here, unpair. Main
 * holds every state; the window reads view() again whenever it is told
 * `machines:changed`. No secret and no hash ever reaches the window.
 */
export interface MachinesHandlerDeps {
  runningAgents: () => number;
  /** How often paired machines are asked (ten seconds); a test shortens it. */
  pollEveryMs?: number;
  /** How often their agents are asked (three seconds); a test shortens it. */
  fleetEveryMs?: number;
}

const changed = () => broadcastToAllWindows('machines:changed', {});

/** The other machines' agents, asked every three seconds while something is paired. */
let fleet: RemoteFleet | null = null;
let fleetTimer: NodeJS.Timeout | null = null;

/** Stops asking the other machines and closes every live output: the quit. */
export function stopFleetPolling(): void {
  if (fleetTimer) clearInterval(fleetTimer);
  fleetTimer = null;
  fleet?.stop();
  fleet = null;
}
const fail = (err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) });

export function registerMachinesHandlers(deps: MachinesHandlerDeps): { startIfPaired: () => Promise<void> } {
  const bridgeDeps = {
    ...fleetSource(),
    runningAgents: deps.runningAgents,
    onChanged: () => { changed(); poll(); },
    onRequestChanged: changed,
    deviceAt: async (address: string) => {
      const peer = (await tailnetPeers()).find(p => p.ip === address);
      return peer ? deviceName(peer) : undefined;
    },
  };
  // Tailscale may come up after Tars: while machines are paired, every poll
  // tries the bridge again until it listens.
  const ensureBridge = async () => {
    if (bridgeState().listening || readMachines().peers.length === 0) return;
    if ((await startBridge(bridgeDeps)).listening) changed();
  };
  const remote = (): RemoteFleet => {
    fleet ??= createRemoteFleet({
      peers: () => readMachines().peers,
      fetchFleet, fetchScreen, openStream, driveAgent,
      onFleet: (agents) => broadcastToAllWindows('machines:fleet', agents),
      onOutput: (agentId, data) => broadcastToAllWindows('agent:output', { type: 'output', agentId, data, timestamp: new Date().toISOString() }),
    });
    return fleet;
  };
  const poll = () => {
    startStatusPolling(changed, deps.pollEveryMs ?? 10_000, ensureBridge);
    if (fleetTimer) return;
    // One poll at a time: a slow machine's answer is waited for, never stacked.
    let polling = false;
    const tick = () => {
      if (polling) return;
      polling = true;
      void remote().poll().finally(() => { polling = false; });
    };
    tick();
    fleetTimer = setInterval(tick, deps.fleetEveryMs ?? 3_000);
  };

  // The other machines' agents, read only (Dashboard, Agents): their screen
  // once per pane, then their live output on agent:output under their remote ids.
  ipcMain.handle('machines:agents', () => remote().list());
  ipcMain.handle('machines:agent-screen', (_e, id: unknown) => (typeof id === 'string' ? remote().screen(id) : null));
  ipcMain.handle('machines:watch', (_e, id: unknown) => { if (typeof id === 'string') remote().watch(id); });
  ipcMain.handle('machines:unwatch', (_e, id: unknown) => { if (typeof id === 'string') remote().unwatch(id); });

  // Driving another machine's agents where it lets this one (machine.drive):
  // that machine checks each action and files it under this machine's name.
  // The fleet is asked again at once, so the window sees what came of it.
  const drive = async (id: unknown, action: 'start' | 'stop' | 'message', body: Record<string, unknown>) => {
    if (typeof id !== 'string') return { success: false as const, error: 'There is no such agent.' };
    const result = await remote().drive(id, action, body);
    if (result.success) void remote().poll();
    return result;
  };
  ipcMain.handle('machines:start-agent', (_e, id: unknown, prompt: unknown) =>
    drive(id, 'start', typeof prompt === 'string' && prompt.trim() ? { prompt } : {}));
  ipcMain.handle('machines:stop-agent', (_e, id: unknown, reason: unknown) => drive(id, 'stop', { reason }));
  ipcMain.handle('machines:message-agent', (_e, id: unknown, text: unknown) => drive(id, 'message', { text }));

  ipcMain.handle('machines:view', async (): Promise<MachinesView> => {
    const file = readMachines();
    const ts = await detectTailscale();
    const offer = currentOffer();
    const request = currentRequest();
    const bridge = bridgeState();
    return {
      self: { ...file.self, address: ts.dnsName ?? ts.ip },
      tailscale: { installed: ts.installed, running: ts.running },
      bridge: { listening: bridge.listening, reason: bridge.reason },
      offer: offer ? { code: formatCode(offer.code), expiresAt: new Date(offer.expiresAt).toISOString() } : null,
      request: request ? { name: request.name, device: request.device, address: request.address, expiresAt: new Date(request.expiresAt).toISOString() } : null,
      peers: file.peers.map(p => ({ id: p.id, name: p.name, address: p.address, mayOnMe: p.mayOnMe, ...peerStatus(p.id) })),
    };
  });

  ipcMain.handle('machines:set-name', async (_e, name: unknown) => {
    try {
      const file = readMachines();
      writeMachines({ ...file, self: { ...file.self, name: cleanName(name) } });
      changed();
      return { success: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('machines:open-offer', async () => {
    const s = await startBridge(bridgeDeps);
    if (!s.listening) return { success: false, error: s.reason ?? 'The bridge is not listening.' };
    const offer = openPairingOffer();
    changed();
    return { success: true, code: formatCode(offer.code), expiresAt: new Date(offer.expiresAt).toISOString() };
  });

  ipcMain.handle('machines:close-offer', async () => {
    closePairingOffer();
    changed();
    return { success: true };
  });

  ipcMain.handle('machines:pair', async (_e, code: unknown) => {
    const s = await startBridge(bridgeDeps);
    if (!s.listening || !s.target) return { success: false, error: s.reason ?? 'The bridge is not listening.' };
    const ts = await detectTailscale();
    const result = await pairWithCode(String(code ?? ''), candidatesFrom(process.env, app?.isPackaged ?? true, ts.peers), s.target.port);
    if (!result.ok) return { success: false, error: result.error };
    changed();
    poll();
    await pollNow(changed);
    return { success: true, name: result.name };
  });

  // The person here answers the machine that knocks (bridge-server, knock).
  ipcMain.handle('machines:accept', async () => (decidePairRequest(true) ? { success: true } : { success: false, error: 'No machine is waiting to pair.' }));
  ipcMain.handle('machines:refuse', async () => (decidePairRequest(false) ? { success: true } : { success: false, error: 'No machine is waiting to pair.' }));

  ipcMain.handle('machines:set-permission', async (_e, id: unknown, mayOnMe: unknown) => {
    if (mayOnMe !== 'see' && mayOnMe !== 'drive') return { success: false, error: 'A machine may see, or drive.' };
    const file = readMachines();
    if (!file.peers.some(p => p.id === id)) return { success: false, error: 'There is no such machine.' };
    writeMachines({ ...file, peers: file.peers.map(p => (p.id === id ? { ...p, mayOnMe } : p)) });
    changed();
    return { success: true };
  });

  ipcMain.handle('machines:unpair', async (_e, id: unknown) => {
    await unpairPeer(String(id));
    // What it was still reading here ends now, not at its next ping.
    closeStreamsOf(String(id));
    forgetStatus(String(id));
    changed();
    return { success: true };
  });

  return {
    startIfPaired: async () => {
      if (readMachines().peers.length === 0) return;
      await startBridge(bridgeDeps);
      poll();
    },
  };
}
