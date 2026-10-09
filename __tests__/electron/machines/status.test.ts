import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { startStatusPolling, stopStatusPolling } from '../../../electron/services/machines/status';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';

/**
 * The status poll, every few seconds while something is paired. How it can
 * fail, written before the code:
 * 1. A poll that takes longer than the interval has another start beside
 *    it, and against a machine that answers slowly they pile up (final
 *    review, Important 3).
 */
let srv: http.Server | null = null;
afterEach(async () => {
  stopStatusPolling();
  if (srv) { srv.closeAllConnections(); await new Promise<void>(r => srv!.close(() => r())); }
  srv = null;
});

describe('the status poll', () => {
  it('never runs two polls at once against a slow machine (1)', async () => {
    fs.rmSync(MACHINES_FILE, { force: true });
    let open = 0;
    let most = 0;
    srv = http.createServer((_req, res) => {
      open++; most = Math.max(most, open);
      setTimeout(() => { open--; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"agentsRunning":0}'); }, 300);
    });
    await new Promise<void>(r => srv!.listen(0, '127.0.0.1', r));
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: 'm-5555555555555555', name: 'Slow', address: '127.0.0.1', port: (srv.address() as AddressInfo).port, inboundSecretHash: hashSecret('s'), outboundSecret: 'D'.repeat(43), mayOnMe: 'see', pairedAt: '' }] });
    startStatusPolling(() => {}, 40);
    await new Promise(r => setTimeout(r, 900));
    expect(most).toBe(1);
  });
});
