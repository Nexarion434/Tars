import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, closeStreamsOf, MAX_STREAMS_PER_MACHINE, type BridgeDeps } from '../../../electron/services/machines/bridge-server';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';

/**
 * What a paired machine reads of this one's agents over the bridge: the
 * fleet, one agent's screen, one agent's live output. Driven over a real
 * socket on 127.0.0.1. How it can fail, written before the code (2026-10-08):
 * 1. One of them answers a caller with no secret, or another machine's.
 * 2. Before any credential is read, a path names whether an agent exists: an
 *    unknown agent answers 404 to a caller with no secret, or a path the
 *    bridge does not serve (another action, an id with a colon, a dot-dot)
 *    answers anything but 404.
 * 3. The fleet is not what this machine shares (fleet-share), or carries no
 *    name of this machine.
 * 4. The screen of an agent with no terminal answers 200 with nothing, or
 *    an error page, where it is 404; or a screen comes without the size it
 *    was drawn for (Mac and PC, 2026-10-09).
 * 5. The live output loses chunks, reorders them, or frames them so a chunk
 *    holding a line break or "data:" reads as two.
 * 6. The output is still listened to after the caller has gone: one listener
 *    per stream ever opened, for the life of the app.
 * 7. A stream outlives its terminal: the caller waits forever on an agent
 *    that ended.
 * 8. One machine opens streams without limit.
 * And from the security review (2026-10-08):
 * 9. A stream outlives its machine's pairing: forgotten here, or paired again
 *    under another secret, the machine goes on reading every chunk.
 * 10. A reader that stops reading is "ended" behind what it never read: the
 *    buffer stays, the slot is freed, and 32 more streams fill again.
 */

let server: http.Server;
let base: string;
const MINE = 'secret-the-pc-presents-here_0123456789abcdef';
const PC = 'm-bbbbbbbbbbbbbbbb';

/** The terminals the bridge can stream, by agent id: what a test writes into one reaches its listeners. */
const terminals = new Map<string, { listeners: Set<(chunk: string) => void>; ends: Set<() => void> }>();
const write = (id: string, chunk: string) => terminals.get(id)!.listeners.forEach(l => l(chunk));
const endTerminal = (id: string) => terminals.get(id)!.ends.forEach(e => e());

const deps: BridgeDeps = {
  runningAgents: () => 1,
  streamCheckMs: 50,
  onChanged: () => {},
  fleet: () => [{ id: 'a1', name: 'Backend Engineer', status: 'running', projectName: 'tars', projectPath: 'C:\\code\\tars', cliRunning: true }],
  screenOf: (agentId) => (agentId === 'a1' ? { screen: '\x1bcline one\r\nline two', cliRunning: true, cols: 132, rows: 40 } : null),
  onOutput: (agentId, listener, onEnd) => {
    const t = terminals.get(agentId);
    if (!t) return null;
    t.listeners.add(listener);
    t.ends.add(onEnd);
    return () => { t.listeners.delete(listener); t.ends.delete(onEnd); };
  },
};

async function call(path: string, secret?: string) {
  const res = await fetch(base + path, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

/** Opens the live output of an agent and collects its events as the SSE framing gives them. */
function stream(agentId: string, secret = MINE) {
  const events: string[] = [];
  let ended = false;
  let raw = '';
  const req = http.get(`${base}/machines/v1/agents/${agentId}/stream`, { headers: { authorization: `Bearer ${secret}` } }, res => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      raw += chunk;
      let at: number;
      while ((at = raw.indexOf('\n\n')) >= 0) {
        const event = raw.slice(0, at);
        raw = raw.slice(at + 2);
        if (event.startsWith('data: ')) events.push(JSON.parse(event.slice(6)));
      }
    });
    res.on('end', () => { ended = true; });
  });
  const status = new Promise<number>(resolve => req.on('response', res => resolve(res.statusCode ?? 0)));
  req.on('error', () => { ended = true; });
  return { events, status, ended: () => ended, close: () => req.destroy() };
}

/** The peer as the beforeEach pairs it, with another secret's hash when given. */
function pairPc(inboundSecretHash = hashSecret(MINE)) {
  const file = readMachines();
  writeMachines({ ...file, peers: [{ ...file.peers[0], inboundSecretHash }] });
}

const until = async (what: string, test: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 10)); }
};

beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  const file = readMachines();
  writeMachines({ ...file, self: { ...file.self, name: 'Mac' }, peers: [{
    id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret(MINE), outboundSecret: 'theirs_0123456789abcdefghijklmnop', mayOnMe: 'see', pairedAt: new Date().toISOString(),
  }] });
  terminals.clear();
  terminals.set('a1', { listeners: new Set(), ends: new Set() });
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));

describe('the fleet, a screen and a stream', () => {
  it('1. answer 401 with no secret or a secret this machine never issued', async () => {
    for (const path of ['/machines/v1/fleet', '/machines/v1/agents/a1/screen', '/machines/v1/agents/a1/stream']) {
      expect((await call(path)).status, path).toBe(401);
      expect((await call(path, 'not-the-secret_0123456789abcdefghijk')).status, path).toBe(401);
    }
  });

  it('2. an unknown agent reads as a refusal before the secret, and a path not served is 404 before it', async () => {
    expect((await call('/machines/v1/agents/nobody/screen')).status).toBe(401);
    for (const path of ['/machines/v1/agents/a1/output', '/machines/v1/agents/a:1/screen', '/machines/v1/agents//screen', '/machines/v1/agents/a1/screen/x']) {
      expect((await call(path)).status, path).toBe(404);
      expect((await call(path, MINE)).status, path).toBe(404);
    }
  });

  it('3. the fleet is what this machine shares, under its own id and name', async () => {
    const r = await call('/machines/v1/fleet', MINE);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: readMachines().self.id, name: 'Mac', agents: deps.fleet!() });
  });

  it('4. a screen is the agent terminal as it is, and 404 for an agent with none', async () => {
    expect(await call('/machines/v1/agents/a1/screen', MINE)).toEqual({ status: 200, body: { screen: '\x1bcline one\r\nline two', cliRunning: true, cols: 132, rows: 40 } });
    expect((await call('/machines/v1/agents/nobody/screen', MINE)).status).toBe(404);
    expect((await call('/machines/v1/agents/nobody/stream', MINE)).status).toBe(404);
  });

  it('5, 7. the stream carries every chunk in order, line breaks and "data:" included, and ends with the terminal', async () => {
    const s = stream('a1');
    expect(await s.status).toBe(200);
    await until('subscribed', () => terminals.get('a1')!.listeners.size === 1);
    const chunks = ['first\r\n', 'data: not an event\n\nstill the same chunk', '\x1b[31mred\x1b[0m', 'é😀'];
    for (const c of chunks) write('a1', c);
    await until('all chunks', () => s.events.length === chunks.length);
    expect(s.events).toEqual(chunks);
    endTerminal('a1');
    await until('the stream ends with the terminal', s.ended);
    expect(terminals.get('a1')!.listeners.size).toBe(0);
  });

  it('6. a caller that goes leaves no listener behind', async () => {
    const s = stream('a1');
    await until('subscribed', () => terminals.get('a1')!.listeners.size === 1);
    s.close();
    await until('released', () => terminals.get('a1')!.listeners.size === 0);
  });

  it('8. one machine has at most MAX_STREAMS_PER_MACHINE streams open at once', async () => {
    const open = Array.from({ length: MAX_STREAMS_PER_MACHINE }, () => stream('a1'));
    expect(await Promise.all(open.map(s => s.status))).toEqual(open.map(() => 200));
    const extra = stream('a1');
    expect(await extra.status).toBe(429);
    open[0].close();
    await until('one released', () => terminals.get('a1')!.listeners.size === MAX_STREAMS_PER_MACHINE - 1);
    const again = stream('a1');
    expect(await again.status).toBe(200);
    for (const s of [...open, extra, again]) s.close();
  });

  it('9. a stream ends once its machine is forgotten here, or paired again under another secret', async () => {
    const forgotten = stream('a1');
    await until('subscribed', () => terminals.get('a1')!.listeners.size === 1);
    const file = readMachines();
    writeMachines({ ...file, peers: [] });
    await until('ended with the pairing', forgotten.ended);
    expect(terminals.get('a1')!.listeners.size).toBe(0);

    writeMachines(file);
    const repaired = stream('a1');
    await until('subscribed again', () => terminals.get('a1')!.listeners.size === 1);
    pairPc(hashSecret('another-secret-entirely_0123456789abcdefgh'));
    await until('ended with the old secret', repaired.ended);
    expect(terminals.get('a1')!.listeners.size).toBe(0);
  });

  it("9. closeStreamsOf ends a machine's streams at once, and no one else's", async () => {
    const s = stream('a1');
    await until('subscribed', () => terminals.get('a1')!.listeners.size === 1);
    closeStreamsOf('m-cccccccccccccccc');
    await new Promise(r => setTimeout(r, 30));
    expect(s.ended()).toBe(false);
    closeStreamsOf(PC);
    await until('ended at once', s.ended, 500);
  });

  it('10. a reader that stops reading has its connection cut, and its slot only then', async () => {
    // A reader that paused never sees the cut while it reads nothing: it is seen here, on the bridge's side.
    const req = http.get(`${base}/machines/v1/agents/a1/stream`, { headers: { authorization: `Bearer ${MINE}` } }, res => { res.pause(); });
    req.on('error', () => {});
    await until('subscribed', () => terminals.get('a1')!.listeners.size === 1);
    const connections = () => new Promise<number>(resolve => server.getConnections((_e, n) => resolve(n)));
    expect(await connections()).toBe(1);
    const big = 'z'.repeat(256 * 1024);
    let written = 0;
    for (; written < 400 && terminals.get('a1')!.listeners.size > 0; written++) write('a1', big);
    expect(terminals.get('a1')!.listeners.size).toBe(0);
    expect(written * big.length).toBeLessThan(64 * 1024 * 1024);
    let open = 1;
    for (const end = Date.now() + 3_000; open > 0 && Date.now() < end; await new Promise(r => setTimeout(r, 20))) open = await connections();
    expect(open, 'the connection is cut, not left holding what was never read').toBe(0);
    req.destroy();
  });
});
