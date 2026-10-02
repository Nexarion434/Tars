import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer } from '../../../electron/services/machines/bridge-server';
import { pairWithCode, ping, candidatesFrom } from '../../../electron/services/machines/client';
import { MACHINES_FILE } from '../../../electron/services/machines/store';
import { formatCode } from '../../../electron/services/machines/pairing';

/**
 * This Tars calling another one, over 127.0.0.1. One process has one
 * machines file, so a whole pairing (two selves) is proved by the E2E
 * (e2e/machines-pairing.spec.ts), where each Tars has its own home; here,
 * the paths a single side decides. How it can fail, written before the code:
 * 1. A code that is not six digits is sent at all, or the page's own
 *    spelling ("482 913") is refused.
 * 2. No machine shows a code and the page says nothing useful.
 * 3. A machine that forgot this one reads as offline forever.
 * 4. A machine that does not answer hangs the poll.
 * 5. Offline peers are tried as candidates, or the development peer list
 *    is honoured in a packaged Tars.
 */
let server: http.Server;
let port: number;
beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  closePairingOffer();
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, { runningAgents: () => 3, onChanged: () => {} }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

describe('candidates', () => {
  it('are the online peers on 31418, or the development list when not packaged (5)', () => {
    const peers = [{ ip: '100.64.0.2', online: true }, { ip: '100.64.0.3', online: false }];
    expect(candidatesFrom({}, true, peers)).toEqual([{ host: '100.64.0.2', port: 31418 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, false, peers)).toEqual([{ host: '127.0.0.1', port: 31484 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, true, peers)).toEqual([{ host: '100.64.0.2', port: 31418 }]);
  });
});

describe('pairing with a code', () => {
  it('says what to do when no machine shows a code (2)', async () => {
    expect(await pairWithCode('482913', [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first.' });
  });

  it('sends nothing for a code that is not six digits, and takes one with its space (1)', async () => {
    openPairingOffer();
    expect(await pairWithCode('48291', [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'A pairing code is six digits.' });
    // Six digits with the page's space reach the other side; here that side is
    // this same machine, which refuses to pair with itself: proof the code was read.
    const offer = openPairingOffer();
    expect(await pairWithCode(formatCode(offer.code), [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'A machine does not pair with itself.' });
  });
});

describe('ping', () => {
  it('reads 401 as unpaired, no answer as offline, quickly (3, 4)', async () => {
    const peer = { id: 'm-3333333333333333', name: 'PC', address: '127.0.0.1', port, inboundSecretHash: '0'.repeat(64), outboundSecret: 'not-known-there', mayOnMe: 'see' as const, pairedAt: '' };
    expect(await ping(peer)).toEqual({ status: 'unpaired' });
    const started = Date.now();
    expect(await ping({ ...peer, address: '10.255.255.1', port: 9 })).toEqual({ status: 'offline' });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
