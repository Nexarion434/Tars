import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * The machines IPC. How it can fail, written before the code:
 * 1. openOffer answers a code while the bridge cannot listen (Tailscale
 *    off), so the other machine can never use it.
 * 2. setPermission takes anything else than see or drive, or an unknown id.
 * 3. A change does not reach the window (machines:changed not sent).
 * 4. view() hands the renderer a secret (outboundSecret or a hash).
 * 5. A machine forgotten here keeps the status it last had, so paired
 *    again it reads "no longer knows this machine" until the next poll,
 *    ten seconds on (final review, Important 6).
 * 6. Tailscale started after Tars: the bridge, which could not listen at
 *    launch, never tries again while machines are paired (final review,
 *    Important 4).
 * 7. The window cannot answer a machine that asks to pair: no accept or
 *    refuse, or one that says yes when nothing waits (2026-10-05).
 * 8. view() does not show who asks, or hands the window its secret; the
 *    window is not told when a request comes or goes.
 */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const sent: string[] = [];
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h) } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: (c: string) => sent.push(c) }));

import { registerMachinesHandlers } from '../../../electron/handlers/machines-handlers';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { stopBridge, bridgeState } from '../../../electron/services/machines/bridge-server';
import { stopStatusPolling, startStatusPolling, peerStatus } from '../../../electron/services/machines/status';
import { answerProof, codeProof } from '../../../electron/services/machines/pairing';

const PC = 'm-bbbbbbbbbbbbbbbb';
const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<Record<string, unknown>>;

beforeEach(async () => {
  stopStatusPolling();
  await stopBridge();
  handlers.clear();
  sent.length = 0;
  fs.rmSync(MACHINES_FILE, { force: true });
  delete process.env.TARS_MACHINES_BIND;
  delete process.env.TARS_MACHINES_PORT;
  delete process.env.TARS_MACHINES_PEERS;
  process.env.DOROTHY_TAILSCALE_BIN = '';
  registerMachinesHandlers({ runningAgents: () => 0 });
});
afterAll(async () => { stopStatusPolling(); await stopBridge(); });

describe('the machines IPC', () => {
  it('gives no code when the bridge cannot listen, and says why (1)', async () => {
    expect(await call('machines:open-offer')).toEqual({ success: false, error: 'Tailscale is not running on this machine, so no other machine can reach it.' });
  });

  it('gives a formatted code when it can (1, 3)', async () => {
    process.env.TARS_MACHINES_BIND = '127.0.0.1';
    process.env.TARS_MACHINES_PORT = '0';
    const r = await call('machines:open-offer');
    expect(r).toMatchObject({ success: true, code: expect.stringMatching(/^\d{3} \d{3}$/) });
    expect(sent).toContain('machines:changed');
  });

  it('sets see or drive on a known machine, and nothing else (2, 3)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('s'), outboundSecret: 'o', mayOnMe: 'see', pairedAt: '' }] });
    expect(await call('machines:set-permission', PC, 'drive')).toEqual({ success: true });
    expect(readMachines().peers[0].mayOnMe).toBe('drive');
    expect(await call('machines:set-permission', PC, 'admin')).toMatchObject({ success: false });
    expect(await call('machines:set-permission', 'm-cccccccccccccccc', 'see')).toMatchObject({ success: false });
    expect(sent).toContain('machines:changed');
  });

  it('never puts a secret in the view (4)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('s'), outboundSecret: 'out-secret', mayOnMe: 'see', pairedAt: '' }] });
    const view = JSON.stringify(await call('machines:view'));
    expect(view).toContain('"PC"');
    expect(view).not.toContain('out-secret');
    expect(view).not.toContain(hashSecret('s'));
  });
});

/** The other machine: shows code 482913, pairs, and answers ping, or forgot this one (401). */
async function otherMachine(mode: { forgot: boolean }) {
  let nonce = '';
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/machines/v1/hello') { nonce = 'f'.repeat(32); return send(200, { id: PC, name: 'PC', nonce }); }
      if (req.url === '/machines/v1/pair') {
        const caller = String(JSON.parse(raw).id);
        return send(200, { id: PC, name: 'PC', secret: 'E'.repeat(43), proof: answerProof('482913', nonce, String(JSON.parse(raw).callerNonce), caller, PC) });
      }
      if (mode.forgot) return send(401, { error: 'Unauthorized' });
      return send(200, { id: PC, name: 'PC', agentsRunning: 2 });
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { srv, port: (srv.address() as AddressInfo).port };
}

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  return check();
};

describe('a machine forgotten, then paired again', () => {
  it('loses the status it had once forgotten (5)', async () => {
    const pc = await otherMachine({ forgot: true });
    try {
      const self = readMachines().self;
      writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: pc.port, inboundSecretHash: hashSecret('s'), outboundSecret: 'E'.repeat(43), mayOnMe: 'see', pairedAt: '' }] });
      startStatusPolling(() => {}, 60_000);
      expect(await until(() => peerStatus(PC).status === 'unpaired')).toBe(true);
      await call('machines:unpair', PC);
      expect(peerStatus(PC)).toEqual({ status: 'unknown' });
    } finally { pc.srv.close(); }
  });

  it('reads connected as soon as the pairing returns, not at the next poll (5)', async () => {
    const pc = await otherMachine({ forgot: false });
    try {
      process.env.TARS_MACHINES_BIND = '127.0.0.1';
      process.env.TARS_MACHINES_PORT = '0';
      process.env.TARS_MACHINES_PEERS = `127.0.0.1:${pc.port}`;
      // Polling already runs (another machine is paired): the next poll is a minute away.
      startStatusPolling(() => {}, 60_000);
      expect(await call('machines:pair', '482 913')).toEqual({ success: true, name: 'PC' });
      expect(peerStatus(PC)).toMatchObject({ status: 'connected', agentsRunning: 2 });
    } finally { pc.srv.close(); }
  });
});

describe('Tailscale started after Tars', () => {
  it('has the bridge listen at the next poll while machines are paired (6)', async () => {
    handlers.clear();
    const { startIfPaired } = registerMachinesHandlers({ runningAgents: () => 0, pollEveryMs: 50 });
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: 9, inboundSecretHash: hashSecret('s'), outboundSecret: 'E'.repeat(43), mayOnMe: 'see', pairedAt: '' }] });
    await startIfPaired();
    expect(bridgeState().listening).toBe(false);
    sent.length = 0;
    // Tailscale comes up: in a development run, the override stands for its address.
    process.env.TARS_MACHINES_BIND = '127.0.0.1';
    process.env.TARS_MACHINES_PORT = '0';
    expect(await until(() => bridgeState().listening)).toBe(true);
    expect(sent).toContain('machines:changed');
  });
});

describe('a machine that asks to pair', () => {
  it('shows in the view without its secret, and pairs once accepted (7, 8)', async () => {
    process.env.TARS_MACHINES_BIND = '127.0.0.1';
    process.env.TARS_MACHINES_PORT = '0';
    const offer = await call('machines:open-offer');
    const code = String(offer.code).replace(/\D/g, '');
    const at = `http://127.0.0.1:${bridgeState().target!.port}`;
    const { nonce } = await (await fetch(at + '/machines/v1/hello')).json() as { nonce: string };
    sent.length = 0;
    const post = (path: string, body: unknown) => fetch(at + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const asking = post('/machines/v1/knock', { id: PC, name: 'PC', nonce });
    expect(await until(() => sent.includes('machines:changed'))).toBe(true);
    const view = await call('machines:view');
    expect(view.request).toMatchObject({ name: 'PC', address: '127.0.0.1' });
    expect(await call('machines:accept')).toEqual({ success: true });
    expect((await asking).status).toBe(200);
    expect((await call('machines:view')).request).toBeNull();
    const secret = 'S'.repeat(43);
    expect((await post('/machines/v1/pair', { id: PC, name: 'PC', port: 31999, callerNonce: 'c'.repeat(32), proof: codeProof(code, nonce, 'c'.repeat(32), PC), secret })).status).toBe(200);
    expect(readMachines().peers.map(p => p.id)).toEqual([PC]);
    expect(JSON.stringify(await call('machines:view'))).not.toContain(secret);
  });

  it('says so when nothing waits to be accepted or refused (7)', async () => {
    expect(await call('machines:accept')).toEqual({ success: false, error: 'No machine is waiting to pair.' });
    expect(await call('machines:refuse')).toEqual({ success: false, error: 'No machine is waiting to pair.' });
  });
});
