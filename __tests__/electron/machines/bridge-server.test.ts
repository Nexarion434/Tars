import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer, resolveBindTarget, isTailnetAddress, currentRequest, decidePairRequest, MACHINES_PORT_DEFAULT } from '../../../electron/services/machines/bridge-server';
import { API_PORT, OPENAI_BRIDGE_PORT } from '../../../electron/constants';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { codeProof, answerProof } from '../../../electron/services/machines/pairing';

/**
 * The machines bridge, driven over a real socket on 127.0.0.1. How it can
 * fail, written before the code:
 * 1. It binds 0.0.0.0, or binds anything when Tailscale gives no address.
 * 2. The development overrides (address, port) work in a packaged Tars.
 * 3. A route of the loopback API answers here (/api/agents), or an unknown
 *    path tells whether auth passed.
 * 4. hello answers with no offer open, so a prober learns a Tars is here
 *    and when a code is shown.
 * 5. pair accepts a wrong proof, a second time, or stores the secret it
 *    issued in clear in place of its hash.
 * 6. ping or unpair answer with no secret, or another peer's secret.
 * 7. A browser page reaches it (an Origin header), or a large body is read
 *    whole.
 * 8. pair answers before the file is written, so a crash in between leaves
 *    one side paired and the other not.
 * 9. Its port is one a loopback server of Tars already holds (the API, or
 *    the OpenAI bridge on the API's port + 1), so the two collide.
 * 10. The pair answer does not prove the code back, so the caller cannot
 *    tell this machine from any other that answers (final review, C1); or
 *    a secret that is not what newSecret makes is stored, and a line break
 *    in it breaks every header this side sends with it.
 * 11. A machine off the tailnet reaches it anyway: on macOS a socket bound
 *    to the Tailscale address also takes what arrives over the LAN for
 *    that address (final review, Important 7). A development run bound to
 *    127.0.0.1 is the one exception.
 * 12. A proof is taken, or the caller written, before the person at this
 *    machine accepts it: a machine that found the code pairs unseen; or the
 *    caller waits for that click with its proof already sent, which gives a
 *    machine answering hello in this one's place a minute, not five
 *    seconds, to try the codes against it (Nicolas, 2026-10-05).
 * 13. A refusal, or no answer within the wait, pairs anyway, or leaves the
 *    code good for another try.
 * 14. A caller that gave up leaves its request waiting for a click.
 * 15. A second caller, while one waits, is asked about too or replaces it;
 *    or a machine other than the one accepted proves the code in its place,
 *    or under another name than the person saw.
 * 16. The request says only the name the caller chose, not who it is as
 *    Tailscale knows it.
 * 17. A request outlives its code: a new code opened while a machine waits
 *    is spent when that old request is refused or runs out, the person
 *    accepts for a code the caller never saw, or the request waits past the
 *    code's own end (security review, 2026-10-05).
 * 18. Knocks that come together each ask Tailscale who they are, one process
 *    each, before any is turned away; a caller gone while Tailscale answered
 *    leaves a request nobody can accept; a second machine knocks in the half
 *    minute the accepted one has to send its proof (security review).
 */
let server: http.Server;
let base: string;
let changed = 0;
/** Most cases are about what follows a pairing: the person here accepts at once. */
let autoAccept = true;
const deps = {
  runningAgents: () => 2,
  onChanged: () => { changed++; },
  onRequestChanged: () => { if (autoAccept && currentRequest()) decidePairRequest(true); },
  deviceAt: async (address: string) => (address === '127.0.0.1' ? 'pc' : undefined),
};
const PC = 'm-bbbbbbbbbbbbbbbb';
const THEIRS = 'their-secret-for-us_0123456789abcdefghijklm';

/** What a machine sends before its proof: who it is. With autoAccept, the person here says yes at once. */
const knock = (id = PC, name = 'PC') => call('POST', '/machines/v1/knock', { id, name });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  changed = 0;
  autoAccept = true;
  decidePairRequest(false);
  closePairingOffer();
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

describe('where the bridge listens', () => {
  it('on the tailnet address, never 0.0.0.0, and nowhere without one (1)', () => {
    expect(resolveBindTarget({}, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31418 });
    expect(resolveBindTarget({}, true, undefined)).toEqual({ reason: expect.stringContaining('Tailscale') });
    expect(resolveBindTarget({ TARS_MACHINES_BIND: '0.0.0.0' }, false, undefined)).toEqual({ reason: expect.any(String) });
  });

  it('takes the development overrides only when not packaged (2)', () => {
    const env = { TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: '31999' };
    expect(resolveBindTarget(env, false, '100.64.0.1')).toEqual({ host: '127.0.0.1', port: 31999 });
    expect(resolveBindTarget(env, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31418 });
  });
});

describe('its port', () => {
  it('is none a loopback server of Tars already holds (9)', () => {
    expect(MACHINES_PORT_DEFAULT).toBe(31418);
    expect([API_PORT, OPENAI_BRIDGE_PORT, 31415, 31416]).not.toContain(MACHINES_PORT_DEFAULT);
  });
});

describe('what it answers', () => {
  it('answers nothing of the loopback API, the same 404 with or without a secret (3)', async () => {
    expect((await call('GET', '/api/agents')).status).toBe(404);
    expect((await call('GET', '/api/agents', undefined, { authorization: 'Bearer x' })).status).toBe(404);
  });

  it('says hello only while an offer is open (4)', async () => {
    expect((await call('GET', '/machines/v1/hello')).status).toBe(404);
    const offer = openPairingOffer();
    const hello = await call('GET', '/machines/v1/hello');
    expect(hello.status).toBe(200);
    expect(hello.body).toEqual({ id: readMachines().self.id, name: readMachines().self.name, nonce: offer.nonce });
  });

  it('pairs once on the right proof, keeps the hash of what it issued, writes before answering (5, 8)', async () => {
    const offer = openPairingOffer();
    expect((await knock()).status).toBe(200);
    const wrong = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: '0'.repeat(64), secret: THEIRS });
    expect(wrong.status).toBe(403);
    const ok = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, callerNonce: 'c'.repeat(32), proof: codeProof(offer.code, offer.nonce, 'c'.repeat(32), PC), secret: THEIRS });
    expect(ok.status).toBe(200);
    const issued = ok.body!.secret as string;
    const peer = readMachines().peers.find(p => p.id === PC)!;
    expect(peer).toMatchObject({ name: 'PC', address: '127.0.0.1', port: 31416, outboundSecret: THEIRS, mayOnMe: 'see', inboundSecretHash: hashSecret(issued) });
    expect(JSON.stringify(readMachines())).not.toContain(issued);
    expect(changed).toBe(1);
    expect((await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, callerNonce: 'c'.repeat(32), proof: codeProof(offer.code, offer.nonce, 'c'.repeat(32), PC), secret: THEIRS })).status).toBe(403);
  });

  it('proves the code back in its answer, over the caller and itself (10)', async () => {
    const offer = openPairingOffer();
    await knock();
    const ok = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, callerNonce: 'c'.repeat(32), proof: codeProof(offer.code, offer.nonce, 'c'.repeat(32), PC), secret: THEIRS });
    expect(ok.status).toBe(200);
    expect(ok.body!.proof).toBe(answerProof(offer.code, offer.nonce, 'c'.repeat(32), PC, readMachines().self.id));
  });

  it.each([['a line break', 'abc\r\nX-Evil: 1' + 'A'.repeat(30)], ['one character short', THEIRS.slice(1)], ['a character newSecret never draws', THEIRS.slice(1) + '=']])
  ('refuses a secret with %s, and stores nothing (10)', async (_what, secret) => {
    const offer = openPairingOffer();
    await knock();
    const r = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, callerNonce: 'c'.repeat(32), proof: codeProof(offer.code, offer.nonce, 'c'.repeat(32), PC), secret });
    expect(r.status).toBe(403);
    expect(readMachines().peers).toEqual([]);
  });

  it('pings and unpairs for the peer secret only (6)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('pc-secret'), outboundSecret: 'x', mayOnMe: 'see', pairedAt: '2026-10-02T00:00:00Z' }] });
    expect((await call('GET', '/machines/v1/ping')).status).toBe(401);
    expect((await call('GET', '/machines/v1/ping', undefined, { authorization: 'Bearer other' })).status).toBe(401);
    expect((await call('GET', '/machines/v1/ping', undefined, { authorization: 'Bearer pc-secret' })).body).toEqual({ id: self.id, name: self.name, agentsRunning: 2 });
    expect((await call('POST', '/machines/v1/unpair', {}, { authorization: 'Bearer pc-secret' })).status).toBe(200);
    expect(readMachines().peers).toEqual([]);
    expect(changed).toBe(1);
  });

  it('refuses a browser and a large body (7)', async () => {
    expect((await call('GET', '/machines/v1/ping', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    openPairingOffer();
    expect((await call('POST', '/machines/v1/pair', { pad: 'x'.repeat(70_000) })).status).toBe(413);
  });
});

describe('who may reach it', () => {
  it('answers only a tailnet address when it listens on the tailnet (11)', async () => {
    const strict = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps, { tailnetOnly: true }); });
    await new Promise<void>(r => strict.listen(0, '127.0.0.1', r));
    try {
      openPairingOffer();
      const at = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
      expect((await fetch(at + '/machines/v1/hello')).status).toBe(403);
      // The development run's own server, beside it, answers the same caller.
      expect((await call('GET', '/machines/v1/hello')).status).toBe(200);
    } finally { await new Promise<void>(r => strict.close(() => r())); }
  });

  it.each([
    ['100.64.0.1', true], ['100.127.255.254', true], ['::ffff:100.100.1.2', true],
    ['100.63.255.255', false], ['100.128.0.1', false], ['192.168.1.20', false], ['127.0.0.1', false], ['', false],
  ])('reads %j as on the tailnet: %s (11)', (address, yes) => {
    expect(isTailnetAddress(address)).toBe(yes);
  });
});

const waitFor = async (check: () => boolean) => {
  const end = Date.now() + 3_000;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  return check();
};

describe('asking the person here before pairing', () => {
  const pairBody = (code: string, nonce: string, id = PC) => ({ id, name: 'PC', port: 31416, callerNonce: 'c'.repeat(32), proof: codeProof(code, nonce, 'c'.repeat(32), id), secret: THEIRS });

  it('takes no proof before the person here accepts, and writes nothing before (12, 16)', async () => {
    autoAccept = false;
    const offer = openPairingOffer();
    const asking = knock();
    expect(await waitFor(() => currentRequest() !== null)).toBe(true);
    expect(currentRequest()).toMatchObject({ name: 'PC', device: 'pc', address: '127.0.0.1' });
    expect((await call('POST', '/machines/v1/pair', pairBody(offer.code, offer.nonce))).status).toBe(403);
    expect(readMachines().peers).toEqual([]);
    expect(changed).toBe(0);
    expect(decidePairRequest(true)).toBe(true);
    expect((await asking).status).toBe(200);
    expect(currentRequest()).toBeNull();
    expect((await call('POST', '/machines/v1/pair', pairBody(offer.code, offer.nonce))).status).toBe(200);
    expect(readMachines().peers.map(p => p.id)).toEqual([PC]);
  });

  it('pairs nothing on a refusal, and the code is spent (13)', async () => {
    autoAccept = false;
    openPairingOffer();
    const asking = knock();
    expect(await waitFor(() => currentRequest() !== null)).toBe(true);
    decidePairRequest(false);
    expect(await asking).toEqual({ status: 403, body: { error: readMachines().self.name + ' refused the pairing.' } });
    expect(readMachines().peers).toEqual([]);
    expect((await call('GET', '/machines/v1/hello')).status).toBe(404);
  });

  it('pairs nothing when nobody answers within the wait, and the code is spent (13)', async () => {
    autoAccept = false;
    const quick = http.createServer((req, res) => { void handleBridgeRequest(req, res, { ...deps, pairWaitMs: 60 }); });
    await new Promise<void>(r => quick.listen(0, '127.0.0.1', r));
    try {
      openPairingOffer();
      const at = 'http://127.0.0.1:' + (quick.address() as AddressInfo).port;
      const res = await fetch(at + '/machines/v1/knock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PC, name: 'PC' }) });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('Nobody accepted the pairing on ' + readMachines().self.name + ' in time.');
      expect(currentRequest()).toBeNull();
      expect((await call('GET', '/machines/v1/hello')).status).toBe(404);
    } finally { await new Promise<void>(r => quick.close(() => r())); }
  });

  it('drops the request of a caller that gave up (14)', async () => {
    autoAccept = false;
    openPairingOffer();
    const body = JSON.stringify({ id: PC, name: 'PC' });
    const req = http.request(base + '/machines/v1/knock', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.end(body);
    expect(await waitFor(() => currentRequest() !== null)).toBe(true);
    req.destroy();
    expect(await waitFor(() => currentRequest() === null)).toBe(true);
    expect(readMachines().peers).toEqual([]);
  });

  it('refuses a second machine while one waits, and keeps asking about the first (15)', async () => {
    autoAccept = false;
    openPairingOffer();
    const first = knock();
    expect(await waitFor(() => currentRequest() !== null)).toBe(true);
    const second = await knock('m-cccccccccccccccc', 'Other');
    expect(second.status).toBe(403);
    expect(currentRequest()).toMatchObject({ name: 'PC' });
    decidePairRequest(true);
    expect((await first).status).toBe(200);
  });

  it('takes the proof of the machine accepted only, under the name the person saw (15)', async () => {
    const offer = openPairingOffer();
    expect((await knock()).status).toBe(200);
    const other = 'm-cccccccccccccccc';
    expect((await call('POST', '/machines/v1/pair', pairBody(offer.code, offer.nonce, other))).status).toBe(403);
    const ok = await call('POST', '/machines/v1/pair', { ...pairBody(offer.code, offer.nonce), name: 'Not what you saw' });
    expect(ok.status).toBe(200);
    expect(readMachines().peers.map(p => [p.id, p.name])).toEqual([[PC, 'PC']]);
  });
});

describe('a request and its code', () => {
  it('answers a waiting machine when the code changes, and the new code stays good (17)', async () => {
    autoAccept = false;
    openPairingOffer();
    const asking = knock();
    expect(await waitFor(() => currentRequest() !== null)).toBe(true);
    const fresh = openPairingOffer();
    const r = await asking;
    expect(r.status).toBe(403);
    expect(currentRequest()).toBeNull();
    const hello = await call('GET', '/machines/v1/hello');
    expect(hello.status).toBe(200);
    expect(hello.body!.nonce).toBe(fresh.nonce);
  });

  it('waits no longer than the code lives (17)', async () => {
    autoAccept = false;
    const offer = openPairingOffer();
    offer.expiresAt = Date.now() + 150;
    const started = Date.now();
    const r = await knock();
    expect(r.status).toBe(403);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('knocks that come together', () => {
  it('ask Tailscale once, and turn the others away (18)', async () => {
    autoAccept = false;
    let lookups = 0;
    const slow = http.createServer((req, res) => { void handleBridgeRequest(req, res, { ...deps, deviceAt: async () => { lookups++; await new Promise(r => setTimeout(r, 150)); return 'pc'; } }); });
    await new Promise<void>(r => slow.listen(0, '127.0.0.1', r));
    try {
      openPairingOffer();
      const at = 'http://127.0.0.1:' + (slow.address() as AddressInfo).port;
      const one = (i: number) => fetch(at + '/machines/v1/knock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'm-' + String(i).repeat(16), name: 'N' + i }) }).then(x => x.status);
      const first = one(1);
      await new Promise(r => setTimeout(r, 30));
      const others = await Promise.all([2, 3, 4, 5].map(one));
      expect(others).toEqual([403, 403, 403, 403]);
      expect(await waitFor(() => currentRequest() !== null)).toBe(true);
      expect(lookups).toBe(1);
      decidePairRequest(false);
      expect(await first).toBe(403);
    } finally { await new Promise<void>(r => slow.close(() => r())); }
  });

  it('leave no request behind a caller gone while Tailscale answered (18)', async () => {
    autoAccept = false;
    const slow = http.createServer((req, res) => { void handleBridgeRequest(req, res, { ...deps, deviceAt: async () => { await new Promise(r => setTimeout(r, 200)); return 'pc'; } }); });
    await new Promise<void>(r => slow.listen(0, '127.0.0.1', r));
    try {
      openPairingOffer();
      const body = JSON.stringify({ id: PC, name: 'PC' });
      const req = http.request('http://127.0.0.1:' + (slow.address() as AddressInfo).port + '/machines/v1/knock', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
      req.on('error', () => {});
      req.end(body);
      await new Promise(r => setTimeout(r, 60));
      req.destroy();
      await new Promise(r => setTimeout(r, 400));
      expect(currentRequest()).toBeNull();
      expect((await call('GET', '/machines/v1/hello')).status).toBe(200);
    } finally { await new Promise<void>(r => slow.close(() => r())); }
  });

  it('turn a second machine away while the accepted one has its half minute (18)', async () => {
    openPairingOffer();
    expect((await knock()).status).toBe(200);
    autoAccept = false;
    expect((await knock('m-cccccccccccccccc', 'Other')).status).toBe(403);
    expect(currentRequest()).toBeNull();
  });
});
