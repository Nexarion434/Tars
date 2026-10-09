import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, MAX_DRIVE_TEXT, MAX_KEYS, type BridgeDeps, type DriveOutcome } from '../../../electron/services/machines/bridge-server';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';

/**
 * Driving this machine's agents from a paired one (multi-machine, part 3):
 * start, stop with a reason, message. Driven over a real socket on
 * 127.0.0.1. How it can fail, written before the code (2026-10-09):
 * 1. A machine this one lets see only, or none, starts, stops or messages an
 *    agent; or the refusal comes after the action ran.
 * 2. Before any credential is read, a path names whether an agent exists;
 *    or a GET reaches an action, or a POST reaches the screen or the stream.
 * 3. The action is filed under a name the caller chose, not the one this
 *    machine paired it under.
 * 4. A stop without a reason goes through, or a reason goes in unbounded or
 *    over several lines.
 * 5. An empty message, or one past MAX_DRIVE_TEXT, is typed.
 * 6. Drive taken back in Settings still drives at the next request.
 * 7. An agent that is not there, or cannot do it now, answers 200, or an
 *    error page with no sentence.
 * 8. The fleet does not tell a machine whether it may drive here, so its
 *    window offers what this one refuses, or hides what it allows.
 * And from the security review of part 3 (2026-10-09):
 * 9. A start carries a first prompt: the CLI's own task, with no sender line,
 *    kept as the agent's role, and on some CLIs read as a flag.
 * 10. Drive taken back while a request is on its way (headers now, body
 *    later) lets it act.
 * 11. A message or a reason made of control or format characters only goes
 *    through as empty.
 * And typing straight into an agent (Nicolas, 2026-10-09):
 * 12. Keys reach an agent from a machine that may only see, by GET, or from
 *    one whose Drive was taken back while they were on their way.
 * 13. Keys are changed on the way: Esc, Enter, Ctrl+C or a paste's markers
 *    taken out (they are what a person types), or a batch past MAX_KEYS, or
 *    an empty one, typed.
 * And the terminal following whoever looks at it (Nicolas, 2026-10-09):
 * 14. A machine that may only see resizes a terminal here, or a size no
 *    terminal can have (zero, a fraction, past 1000, text) is passed on.
 */

let server: http.Server;
let base: string;
const MINE = 'secret-the-pc-presents-here_0123456789abcdef';
const PC = 'm-bbbbbbbbbbbbbbbb';
let calls: Array<[string, string, string, string | undefined]>;
let outcome: DriveOutcome;

const deps: BridgeDeps = {
  runningAgents: () => 1,
  onChanged: () => {},
  fleet: () => [],
  drive: {
    // Whatever it is handed, a third argument included, so a prompt passed on is seen.
    start: async (...args: unknown[]) => { calls.push(['start', String(args[0]), String(args[1]), args[2] as string | undefined]); return outcome; },
    stop: async (agentId, by, reason) => { calls.push(['stop', agentId, by, reason]); return outcome; },
    message: async (agentId, by, text) => { calls.push(['message', agentId, by, text]); return outcome; },
    keys: async (agentId, by, data) => { calls.push(['keys', agentId, by, data]); return outcome; },
    size: async (agentId, by, cols, rows) => { calls.push(['size', agentId, by, `${cols}x${rows}`]); return outcome; },
  },
};

function pair(mayOnMe: 'see' | 'drive') {
  const file = readMachines();
  writeMachines({ ...file, self: { ...file.self, name: 'Mac' }, peers: [{
    id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret(MINE), outboundSecret: 'theirs_0123456789abcdefghijklmnop', mayOnMe, pairedAt: new Date().toISOString(),
  }] });
}

async function call(method: string, path: string, body?: unknown, secret: string | null = MINE) {
  const res = await fetch(base + path, { method, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  pair('drive');
  calls = [];
  outcome = { ok: true };
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));

describe('driving an agent here', () => {
  it('1. a machine that may only see is refused, with a sentence, and nothing runs', async () => {
    pair('see');
    for (const [action, body] of [['start', {}], ['stop', { reason: 'night' }], ['message', { text: 'hi' }]] as const) {
      const r = await call('POST', `/machines/v1/agents/a1/${action}`, body);
      expect(r.status, action).toBe(403);
      expect(r.body?.error).toBe('Mac lets PC see only.');
    }
    expect(calls).toEqual([]);
  });

  it('1. no secret, or one never issued, is 401 and nothing runs', async () => {
    expect((await call('POST', '/machines/v1/agents/a1/stop', { reason: 'x' }, null)).status).toBe(401);
    expect((await call('POST', '/machines/v1/agents/a1/stop', { reason: 'x' }, 'not-the-secret_0123456789abcdefghijk')).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('2. a GET on an action, a POST on the screen or the stream, or another action is 404 before the secret', async () => {
    for (const [method, path] of [['GET', '/machines/v1/agents/a1/start'], ['GET', '/machines/v1/agents/a1/stop'], ['POST', '/machines/v1/agents/a1/screen'], ['POST', '/machines/v1/agents/a1/stream'], ['POST', '/machines/v1/agents/a1/delete'], ['POST', '/machines/v1/agents/a:1/stop']] as const) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(method, path, body, null)).status, `${method} ${path}`).toBe(404);
      expect((await call(method, path, body)).status, `${method} ${path} with the secret`).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('3, 4. a stop is filed under the name this machine paired the caller under, with one bounded line of reason', async () => {
    const r = await call('POST', '/machines/v1/agents/a1/stop', { reason: `out of budget\nsecond line ${'x'.repeat(500)}`, by: 'Someone else' });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toHaveLength(1);
    const [action, agentId, by, reason] = calls[0];
    expect([action, agentId, by]).toEqual(['stop', 'a1', 'PC']);
    expect(reason).not.toContain('\n');
    expect(reason!.startsWith('out of budget second line')).toBe(true);
    expect(reason!.length).toBeLessThanOrEqual(200);
  });

  it('4. a stop with no reason, or a blank one, is 400 and nothing runs', async () => {
    for (const body of [{}, { reason: '' }, { reason: '   \n ' }, { reason: 42 }]) {
      const r = await call('POST', '/machines/v1/agents/a1/stop', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body?.error).toBe('A stop needs a reason.');
    }
    expect(calls).toEqual([]);
  });

  it('5. a message is typed as given, and an empty one or one past the limit is refused', async () => {
    expect((await call('POST', '/machines/v1/agents/a1/message', { text: 'run the tests\nthen tell me' })).status).toBe(200);
    expect(calls).toEqual([['message', 'a1', 'PC', 'run the tests\nthen tell me']]);
    calls = [];
    for (const text of [undefined, '', '  ', 7]) expect((await call('POST', '/machines/v1/agents/a1/message', { text })).status, String(text)).toBe(400);
    const long = await call('POST', '/machines/v1/agents/a1/message', { text: 'x'.repeat(MAX_DRIVE_TEXT + 1) });
    expect(long.status).toBe(413);
    expect(long.body?.error).toMatch(/at most/);
    expect(calls).toEqual([]);
  });

  it('9. a start takes no first prompt: one sent is never handed on', async () => {
    expect((await call('POST', '/machines/v1/agents/a1/start', {})).status).toBe(200);
    expect((await call('POST', '/machines/v1/agents/a1/start', { prompt: '--dangerously-bypass-approvals-and-sandbox' })).status).toBe(200);
    expect(calls).toEqual([['start', 'a1', 'PC', undefined], ['start', 'a1', 'PC', undefined]]);
  });

  it('10. drive taken back while a request is on its way refuses it, and nothing runs', async () => {
    const body = JSON.stringify({ text: 'sent before the change, read after it' });
    const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(`${base}/machines/v1/agents/a1/message`, {
        method: 'POST',
        headers: { authorization: `Bearer ${MINE}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, text })); });
      req.on('error', reject);
      req.flushHeaders();
      // The person here takes Drive back while the body is still on its way.
      setTimeout(() => { pair('see'); req.end(body); }, 100);
    });
    const r = await answer;
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toBe('Mac lets PC see only.');
    expect(calls).toEqual([]);
  });

  it('11. a message or a reason of control and format characters only is refused as empty', async () => {
    for (const text of ['\u0007', '\u001b\u0007', '\u200b\u202e', ' \u0000 ', '\u001b[200~', '\u001b[201~\u001b[200~ ']) {
      expect((await call('POST', '/machines/v1/agents/a1/message', { text })).status, JSON.stringify(text)).toBe(400);
    }
    for (const reason of ['\u0007', '\u202e\u200b', '\u001b']) {
      expect((await call('POST', '/machines/v1/agents/a1/stop', { reason })).status, JSON.stringify(reason)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('6. drive taken back here refuses the very next request', async () => {
    expect((await call('POST', '/machines/v1/agents/a1/start', {})).status).toBe(200);
    pair('see');
    expect((await call('POST', '/machines/v1/agents/a1/start', {})).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('7. an agent not there is 404, one that cannot do it now 409, each with its sentence', async () => {
    outcome = { ok: false, status: 404, error: 'There is no such agent on Mac.' };
    expect(await call('POST', '/machines/v1/agents/a1/stop', { reason: 'x' })).toEqual({ status: 404, body: { error: 'There is no such agent on Mac.' } });
    outcome = { ok: false, status: 409, error: 'QA Engineer is not running on Mac: start it first.' };
    expect(await call('POST', '/machines/v1/agents/a1/message', { text: 'hi' })).toEqual({ status: 409, body: { error: 'QA Engineer is not running on Mac: start it first.' } });
  });

  it('8. the fleet tells a machine what it may do here', async () => {
    expect((await call('GET', '/machines/v1/fleet')).body?.youMay).toBe('drive');
    pair('see');
    expect((await call('GET', '/machines/v1/fleet')).body?.youMay).toBe('see');
  });
});

describe('typing into an agent here', () => {
  it('12. keys from a machine that may only see, or by GET, are refused and typed nowhere', async () => {
    pair('see');
    const r = await call('POST', '/machines/v1/agents/a1/keys', { data: 'ls\r' });
    expect(r.status).toBe(403);
    expect(r.body?.error).toBe('Mac lets PC see only.');
    pair('drive');
    expect((await call('GET', '/machines/v1/agents/a1/keys', undefined, null)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('13. keys are typed exactly as sent: Esc, Enter, Ctrl+C and a paste included', async () => {
    const data = 'y\r\u001b\u0003\u001b[200~pasted\nlines\u001b[201~\u001b[A';
    expect((await call('POST', '/machines/v1/agents/a1/keys', { data })).status).toBe(200);
    expect(calls).toEqual([['keys', 'a1', 'PC', data]]);
  });

  it('13. an empty batch, a batch past MAX_KEYS or one that is not text is refused', async () => {
    for (const data of ['', undefined, 7]) expect((await call('POST', '/machines/v1/agents/a1/keys', { data })).status, String(data)).toBe(400);
    expect((await call('POST', '/machines/v1/agents/a1/keys', { data: 'x'.repeat(MAX_KEYS + 1) })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('12. keys on their way when Drive is taken back are refused', async () => {
    const body = JSON.stringify({ data: 'rm -rf .\r' });
    const answer = new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/machines/v1/agents/a1/keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${MINE}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.flushHeaders();
      setTimeout(() => { pair('see'); req.end(body); }, 100);
    });
    expect(await answer).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('sizing an agent\'s terminal here', () => {
  it('14. a machine that may drive gives the size its pane draws at, as whole numbers a terminal can have', async () => {
    expect((await call('POST', '/machines/v1/agents/a1/size', { cols: 96, rows: 28 })).status).toBe(200);
    expect(calls).toEqual([['size', 'a1', 'PC', '96x28']]);
    calls = [];
    for (const body of [{ cols: 0, rows: 28 }, { cols: 96.5, rows: 28 }, { cols: 1001, rows: 28 }, { cols: '96', rows: 28 }, { cols: 96 }]) {
      expect((await call('POST', '/machines/v1/agents/a1/size', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('14. a machine that may only see sizes nothing', async () => {
    pair('see');
    expect((await call('POST', '/machines/v1/agents/a1/size', { cols: 96, rows: 28 })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
