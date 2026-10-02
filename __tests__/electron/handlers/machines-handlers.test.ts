import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';

/**
 * The machines IPC. How it can fail, written before the code:
 * 1. openOffer answers a code while the bridge cannot listen (Tailscale
 *    off), so the other machine can never use it.
 * 2. setPermission takes anything else than see or drive, or an unknown id.
 * 3. A change does not reach the window (machines:changed not sent).
 * 4. view() hands the renderer a secret (outboundSecret or a hash).
 */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const sent: string[] = [];
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h) } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: (c: string) => sent.push(c) }));

import { registerMachinesHandlers } from '../../../electron/handlers/machines-handlers';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { stopBridge } from '../../../electron/services/machines/bridge-server';
import { stopStatusPolling } from '../../../electron/services/machines/status';

const PC = 'm-bbbbbbbbbbbbbbbb';
const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<Record<string, unknown>>;

beforeEach(async () => {
  await stopBridge();
  handlers.clear();
  sent.length = 0;
  fs.rmSync(MACHINES_FILE, { force: true });
  delete process.env.TARS_MACHINES_BIND;
  delete process.env.TARS_MACHINES_PORT;
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
