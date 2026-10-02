import { app, ipcMain } from 'electron';
import { broadcastToAllWindows } from '../utils/broadcast';
import { readMachines, writeMachines, cleanName } from '../services/machines/store';
import { startBridge, bridgeState, openPairingOffer, closePairingOffer, currentOffer } from '../services/machines/bridge-server';
import { pairWithCode, candidatesFrom, unpairPeer } from '../services/machines/client';
import { startStatusPolling, peerStatus, forgetStatus, pollNow } from '../services/machines/status';
import { formatCode } from '../services/machines/pairing';
import { detectTailscale } from '../services/tailscale-status';
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
}

const changed = () => broadcastToAllWindows('machines:changed', {});
const fail = (err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) });

export function registerMachinesHandlers(deps: MachinesHandlerDeps): { startIfPaired: () => Promise<void> } {
  const bridgeDeps = {
    runningAgents: deps.runningAgents,
    onChanged: () => { changed(); poll(); },
  };
  // Tailscale may come up after Tars: while machines are paired, every poll
  // tries the bridge again until it listens.
  const ensureBridge = async () => {
    if (bridgeState().listening || readMachines().peers.length === 0) return;
    if ((await startBridge(bridgeDeps)).listening) changed();
  };
  const poll = () => startStatusPolling(changed, deps.pollEveryMs ?? 10_000, ensureBridge);

  ipcMain.handle('machines:view', async (): Promise<MachinesView> => {
    const file = readMachines();
    const ts = await detectTailscale();
    const offer = currentOffer();
    const bridge = bridgeState();
    return {
      self: { ...file.self, address: ts.dnsName ?? ts.ip },
      tailscale: { installed: ts.installed, running: ts.running },
      bridge: { listening: bridge.listening, reason: bridge.reason },
      offer: offer ? { code: formatCode(offer.code), expiresAt: new Date(offer.expiresAt).toISOString() } : null,
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
