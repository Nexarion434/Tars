import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The transport under every orchestrator call.
 *
 * `wait_for_agent` and `delegate_task` failed, three times out of three in one
 * day, with `TypeError: fetch failed`: no status, no code, no duration. That
 * error is undici's, and it is what a request gets when it has sent nothing
 * for `headersTimeout` milliseconds - 300000 of them by default, set by
 * nothing in this repo and visible to nothing in this repo. A long poll is
 * silence by definition: /wait and /run-task write no byte at all until the
 * agent's status changes or its turn ends. So every wait worth making, and
 * every delegation over a few minutes, was cut by a clock nobody asked for.
 *
 * Measured against a server that never answers:
 *
 *   [fetch] FAILED at 302.2s: TypeError: fetch failed cause=Headers Timeout
 *   [http]  still open at 400s, no error
 *
 * These assert the shape of the fix rather than sitting through five minutes:
 * that the caller's timeout is the only clock, that a response after a long
 * silence still arrives, and that global fetch is not involved at all - which
 * is the property that would be lost if this were ever written back.
 */

const API_TOKEN_FILE_CONTENT = 'test-token';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: string) => (String(p).endsWith('api-token') ? true : actual.existsSync(p)),
    readFileSync: (p: string, ...rest: unknown[]) =>
      String(p).endsWith('api-token')
        ? API_TOKEN_FILE_CONTENT
        : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
});

let server: http.Server;
let baseUrl: string;
/** How each request should be answered, set per test. */
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeEach(async () => {
  vi.resetModules();
  handler = (_req, res) => res.end('{}');
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CLAUDE_MGR_API_URL = baseUrl;
});

afterEach(async () => {
  delete process.env.CLAUDE_MGR_API_URL;
  await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
});

async function loadApi() {
  return import('../../mcp-orchestrator/src/utils/api.js');
}

describe('the orchestrator HTTP client', () => {
  it('delivers a long poll that answers only after a long silence', async () => {
    // The shape of a real /wait: headers withheld until there is something to
    // say. Compressed to 1.2s, but it is the same silence undici cut at 300.
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', lastCleanOutput: 'done' }));
      }, 1200);
    };

    const { apiRequest } = await loadApi();
    const result = await apiRequest('/api/agents/a1/wait?timeout=30', 'GET', undefined, 10_000);

    expect(result).toEqual({ status: 'completed', lastCleanOutput: 'done' });
  });

  it('never goes through global fetch, whose hidden clock was the bug', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    handler = (_req, res) => res.end(JSON.stringify({ ok: true }));

    const { apiRequest } = await loadApi();
    await apiRequest('/api/agents/a1/wait?timeout=30');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('times out on the caller\'s budget and says how long it waited', async () => {
    handler = () => { /* never answers, as a long poll does not until it must */ };

    const { apiRequest } = await loadApi();
    const started = Date.now();
    await expect(
      apiRequest('/api/agents/a1/wait?timeout=600', 'GET', undefined, 700)
    ).rejects.toThrow(/Timed out after \d+s waiting for GET \/api\/agents\/a1\/wait/);

    // The caller's budget, not undici's: a five-minute ceiling would have let
    // this run for five minutes.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a socket error with its errno instead of flattening it', async () => {
    handler = (_req, res) => res.destroy();

    const { apiRequest } = await loadApi();
    await expect(apiRequest('/api/agents/a1', 'GET', undefined, 5_000))
      .rejects.toThrow(/ECONNRESET|socket hang up/);
  });

  it('surfaces the server\'s own error text on a non-2xx', async () => {
    handler = (_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no ACP mode; use /dispatch' }));
    };

    const { apiRequest } = await loadApi();
    await expect(apiRequest('/api/agents/a1/run-task', 'POST', { task: 'x' }, 5_000))
      .rejects.toThrow('no ACP mode; use /dispatch');
  });

  it('sends the body it was given, with a matching Content-Length', async () => {
    let seen: { body: string; length?: string } | undefined;
    handler = (req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen = { body: raw, length: req.headers['content-length'] };
        res.end(JSON.stringify({ ok: true }));
      });
    };

    const { apiRequest } = await loadApi();
    await apiRequest('/api/agents/a1/run-task', 'POST', { task: 'héllo' }, 5_000);

    expect(seen?.body).toBe(JSON.stringify({ task: 'héllo' }));
    // Bytes, not characters: the accented one is two.
    expect(Number(seen?.length)).toBe(Buffer.byteLength(JSON.stringify({ task: 'héllo' })));
  });
});
