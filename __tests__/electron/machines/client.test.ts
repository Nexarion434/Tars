import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer } from '../../../electron/services/machines/bridge-server';
import { pairWithCode, ping, candidatesFrom, unpairPeer } from '../../../electron/services/machines/client';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { formatCode, answerProof } from '../../../electron/services/machines/pairing';

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
 * 6. A machine that answers hello and pair without knowing the code is
 *    taken for the offering one and stored (final review, Critical 1).
 * 7. An answer whose id, name or secret is not what pairing makes is
 *    stored: a name with a direction override, a secret that breaks a
 *    header, an id that differs from hello's or is this machine's own.
 * 8. A machine shared in from another tailnet is tried as a candidate.
 * 9. Unpairing a machine that does not answer, or whose stored secret
 *    cannot be sent, leaves it in the list for good.
 * 10. A machine that sends its headers and then stalls, or drops the
 *    connection mid-answer, holds the call forever, and the status poll
 *    with it (final review, Important 3).
 * 11. An answer of any size is read whole into memory.
 * 12. The typing machine sends its proof before the other machine's person
 *    accepted it, so whoever answered hello holds a proof while the person
 *    reads; or it gives up after five seconds, while that person is still
 *    reading who asks (Nicolas, 2026-10-05).
 * 14. The proof is made over the answering machine's nonce alone, so that
 *    machine can work out every key in advance (security review,
 *    2026-10-05): the typing machine must draw its own, fresh each time.
 * 13. "No machine shows a code" says nothing of Tailscale's access rules,
 *    the cause the first real pairing met (2026-10-05).
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
  it('are the online peers of this tailnet on 31418, or the development list when not packaged (5, 8)', () => {
    const peers = [{ ip: '100.64.0.2', online: true }, { ip: '100.64.0.3', online: false }, { ip: '100.64.0.9', online: true, shared: true }];
    expect(candidatesFrom({}, true, peers)).toEqual([{ host: '100.64.0.2', port: 31418 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, false, peers)).toEqual([{ host: '127.0.0.1', port: 31484 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, true, peers)).toEqual([{ host: '100.64.0.2', port: 31418 }]);
  });
});

describe('pairing with a code', () => {
  it('says what to do when no machine shows a code, Tailscale access rules included (2, 13)', async () => {
    expect(await pairWithCode('482913', [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: "No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first. If it shows one, your Tailscale access rules may keep the two apart: they must let them reach each other on port 31418." });
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

/** A machine of the tailnet that does not know the code, and answers as if it did. */
async function impostor(answer: (body: Record<string, unknown>) => Record<string, unknown>) {
  const got: Record<string, unknown>[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/machines/v1/hello') return res.end(JSON.stringify({ id: 'm-dddddddddddddddd', name: 'Mac', nonce: 'a'.repeat(32) }));
      const body = JSON.parse(raw || '{}');
      got.push(body);
      res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { srv, port: (srv.address() as AddressInfo).port, got };
}

describe('the answer to a pairing', () => {
  const GOOD_SECRET = 'A'.repeat(43);

  it('is refused, and nothing is stored, when the machine does not prove the code back (6)', async () => {
    const fake = await impostor(() => ({ id: 'm-dddddddddddddddd', name: 'Mac', secret: GOOD_SECRET }));
    try {
      const r = await pairWithCode('482913', [{ host: '127.0.0.1', port: fake.port }], 31418);
      expect(r).toEqual({ ok: false, error: 'That machine did not prove it knows the code. Nothing was paired.' });
      expect(readMachines().peers).toEqual([]);
    } finally { fake.srv.close(); }
  });

  it.each([
    ['a name with a direction override', { name: 'Mac\u202Eevil' }],
    ['a secret that breaks a header', { secret: 'abc\r\nX-Evil: 1' + 'A'.repeat(30) }],
    ['an id that is not hello\'s', { id: 'm-eeeeeeeeeeeeeeee' }],
  ])('is refused when it carries %s, even with the right proof (7)', async (_what, change) => {
    const fake = await impostor(body => {
      const id = (change as { id?: string }).id ?? 'm-dddddddddddddddd';
      return { id, name: 'Mac', secret: GOOD_SECRET, ...change, proof: answerProof('482913', 'a'.repeat(32), String(body.callerNonce), String(body.id), id) };
    });
    try {
      const r = await pairWithCode('482913', [{ host: '127.0.0.1', port: fake.port }], 31418);
      expect(r.ok).toBe(false);
      expect(readMachines().peers).toEqual([]);
    } finally { fake.srv.close(); }
  });

  it('is taken when the machine proves the code back and its fields are what pairing makes', async () => {
    const fake = await impostor(body => ({ id: 'm-dddddddddddddddd', name: 'Mac', secret: GOOD_SECRET, proof: answerProof('482913', 'a'.repeat(32), String(body.callerNonce), String(body.id), 'm-dddddddddddddddd') }));
    try {
      expect(await pairWithCode('482 913', [{ host: '127.0.0.1', port: fake.port }], 31418)).toEqual({ ok: true, name: 'Mac' });
      expect(readMachines().peers.map(p => p.id)).toEqual(['m-dddddddddddddddd']);
    } finally { fake.srv.close(); }
  });
});

describe('unpairing', () => {
  it('forgets the machine here even when it cannot be told: no answer, or a secret that cannot be sent (9)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [
      { id: 'm-1111111111111111', name: 'Gone', address: '10.255.255.1', port: 9, inboundSecretHash: hashSecret('x'), outboundSecret: 'B'.repeat(43), mayOnMe: 'see', pairedAt: '' },
      { id: 'm-2222222222222222', name: 'Broken', address: '127.0.0.1', port, inboundSecretHash: hashSecret('y'), outboundSecret: 'bad\r\nsecret', mayOnMe: 'see', pairedAt: '' },
    ] });
    await unpairPeer('m-1111111111111111');
    await unpairPeer('m-2222222222222222');
    expect(readMachines().peers).toEqual([]);
  });
});

/** A machine that answers ping in its own way. */
async function oddPeer(handler: (res: http.ServerResponse) => void) {
  const srv = http.createServer((_req, res) => handler(res));
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const at = (srv.address() as AddressInfo).port;
  const peer = { id: 'm-4444444444444444', name: 'Odd', address: '127.0.0.1', port: at, inboundSecretHash: '0'.repeat(64), outboundSecret: 'C'.repeat(43), mayOnMe: 'see' as const, pairedAt: '' };
  return { srv, peer };
}

describe('an answer that never ends well', () => {
  it.each([
    ['sends its headers and stalls', (res: http.ServerResponse) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"agentsRunning":'); }],
    ['drops the connection mid-answer', (res: http.ServerResponse) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"agentsRunning":'); setTimeout(() => res.socket?.destroy(), 50); }],
  ])('reads offline, within its own time limit, from a machine that %s (10)', async (_what, handler) => {
    const { srv, peer } = await oddPeer(handler);
    try {
      const started = Date.now();
      expect(await ping(peer)).toEqual({ status: 'offline' });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { srv.closeAllConnections(); srv.close(); }
  }, 10_000);

  it('stops reading an answer past 64 KB, and reads it as offline (11)', async () => {
    const { srv, peer } = await oddPeer(res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ agentsRunning: 1, pad: 'x'.repeat(200_000) })); });
    try {
      expect(await ping(peer)).toEqual({ status: 'offline' });
    } finally { srv.closeAllConnections(); srv.close(); }
  });
});

describe('waiting for the other machine to accept', () => {
  it('asks first, sends its proof only once accepted, and waits past five seconds for the click (12)', async () => {
    const seen: string[] = [];
    let accepted = false;
    const other = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push(String(req.url));
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/machines/v1/hello') return send(200, { id: 'm-dddddddddddddddd', name: 'Mac', nonce: 'a'.repeat(32) });
        if (req.url === '/machines/v1/knock') { setTimeout(() => { accepted = true; send(200, { ok: true }); }, 5_500); return; }
        if (!accepted) return send(403, { error: 'Mac has not accepted this machine. Pair again, and accept it there.' });
        const body = JSON.parse(raw || '{}');
        send(200, { id: 'm-dddddddddddddddd', name: 'Mac', secret: 'A'.repeat(43), proof: answerProof('482913', 'a'.repeat(32), String(body.callerNonce), String(body.id), 'm-dddddddddddddddd') });
      });
    });
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r));
    try {
      const r = await pairWithCode('482913', [{ host: '127.0.0.1', port: (other.address() as AddressInfo).port }], 31418);
      expect(r).toEqual({ ok: true, name: 'Mac' });
      expect(seen).toEqual(['/machines/v1/hello', '/machines/v1/knock', '/machines/v1/pair']);
    } finally { other.close(); }
  }, 15_000);

  it('passes on what the other machine says when its person refuses, and sends no proof (12)', async () => {
    const seen: string[] = [];
    const other = http.createServer((req, res) => {
      seen.push(String(req.url));
      res.writeHead(req.url === '/machines/v1/hello' ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/machines/v1/hello' ? { id: 'm-dddddddddddddddd', name: 'Mac', nonce: 'a'.repeat(32) } : { error: 'Mac refused the pairing.' }));
    });
    await new Promise<void>(r => other.listen(0, '127.0.0.1', r));
    try {
      expect(await pairWithCode('482913', [{ host: '127.0.0.1', port: (other.address() as AddressInfo).port }], 31418)).toEqual({ ok: false, error: 'Mac refused the pairing.' });
      expect(seen).toEqual(['/machines/v1/hello', '/machines/v1/knock']);
    } finally { other.close(); }
  });
});

describe('the nonce this machine draws', () => {
  it('is fresh for each pairing, and sent with the proof (14)', async () => {
    const fake = await impostor(() => ({ error: 'no' }));
    try {
      await pairWithCode('482913', [{ host: '127.0.0.1', port: fake.port }], 31418);
      await pairWithCode('482913', [{ host: '127.0.0.1', port: fake.port }], 31418);
      const sent = fake.got.filter(b => 'proof' in b).map(b => b.callerNonce);
      expect(sent).toHaveLength(2);
      for (const n of sent) expect(n).toMatch(/^[0-9a-f]{32}$/);
      expect(sent[0]).not.toBe(sent[1]);
    } finally { fake.srv.close(); }
  });
});
