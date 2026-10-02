import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer, resolveBindTarget } from '../../../electron/services/machines/bridge-server';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { codeProof } from '../../../electron/services/machines/pairing';

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
 */
let server: http.Server;
let base: string;
let changed = 0;
const deps = { runningAgents: () => 2, onChanged: () => { changed++; } };
const PC = 'm-bbbbbbbbbbbbbbbb';
const THEIRS = 'their-secret-for-us-0123456789abcdefghijk';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  changed = 0;
  closePairingOffer();
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

describe('where the bridge listens', () => {
  it('on the tailnet address, never 0.0.0.0, and nowhere without one (1)', () => {
    expect(resolveBindTarget({}, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31416 });
    expect(resolveBindTarget({}, true, undefined)).toEqual({ reason: expect.stringContaining('Tailscale') });
    expect(resolveBindTarget({ TARS_MACHINES_BIND: '0.0.0.0' }, false, undefined)).toEqual({ reason: expect.any(String) });
  });

  it('takes the development overrides only when not packaged (2)', () => {
    const env = { TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: '31999' };
    expect(resolveBindTarget(env, false, '100.64.0.1')).toEqual({ host: '127.0.0.1', port: 31999 });
    expect(resolveBindTarget(env, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31416 });
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
    const wrong = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: '0'.repeat(64), secret: THEIRS });
    expect(wrong.status).toBe(403);
    const ok = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: codeProof(offer.code, offer.nonce, PC), secret: THEIRS });
    expect(ok.status).toBe(200);
    const issued = ok.body!.secret as string;
    const peer = readMachines().peers.find(p => p.id === PC)!;
    expect(peer).toMatchObject({ name: 'PC', address: '127.0.0.1', port: 31416, outboundSecret: THEIRS, mayOnMe: 'see', inboundSecretHash: hashSecret(issued) });
    expect(JSON.stringify(readMachines())).not.toContain(issued);
    expect(changed).toBe(1);
    expect((await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: codeProof(offer.code, offer.nonce, PC), secret: THEIRS })).status).toBe(403);
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
