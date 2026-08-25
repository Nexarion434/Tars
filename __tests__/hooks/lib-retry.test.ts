import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * hooks/lib.sh: the plumbing the agent status lifecycle actually runs on.
 *
 * Every hook used to make one `curl --max-time 3` and discard the result.
 * Status is these posts and nothing else, so a single lost curl - the port
 * refusing for a moment while the app is busy, a connection reset - left an
 * agent labelled `running` with nothing left in the system that would ever
 * say otherwise. That is the ghost status, and it is also why a day's worth
 * of `lastCleanOutput` was never captured: the output post is the same call.
 *
 * These run the real script against a real server that fails on purpose.
 */

const LIB = path.resolve(process.cwd(), 'hooks/lib.sh');

let server: http.Server;
let port: number;
/** Requests seen, in order. */
let hits: Array<{ url: string; body: string }>;
/** Decides what each attempt gets. */
let behaviour: (attempt: number, res: http.ServerResponse) => void;

beforeEach(async () => {
  hits = [];
  behaviour = (_a, res) => res.end('{"success":true}');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      hits.push({ url: req.url || '', body: raw });
      behaviour(hits.length, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
});

/** Source lib.sh and run one command against the test server. */
function runHookSnippet(snippet: string, env: Record<string, string> = {}): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    execFile(
      '/bin/bash',
      ['-c', `source "${LIB}"\n${snippet}`],
      { env: { ...process.env, DOROTHY_API_PORT: String(port), ...env } },
      (err, stdout) => resolve({ stdout, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
  });
}

describe('hooks/lib.sh', () => {
  it('builds its URL from DOROTHY_API_PORT, not a port baked into the script', async () => {
    // Every hook had 31415 written into it. A Tars on another port - the
    // sandbox, an e2e run - had its agents posting to whoever owned 31415.
    const { stdout } = await runHookSnippet('printf %s "$TARS_API_URL"');
    expect(stdout).toBe(`http://127.0.0.1:${port}`);
  });

  it('falls back to 31415 when nothing overrides it', async () => {
    const { stdout } = await runHookSnippet('printf %s "$TARS_API_URL"', { DOROTHY_API_PORT: '' });
    expect(stdout).toBe('http://127.0.0.1:31415');
  });

  it('gets the status post through after the connection is dropped twice', async () => {
    // The lost-curl case. One post used to be the whole story.
    behaviour = (attempt, res) => {
      if (attempt < 3) { res.destroy(); return; }
      res.end('{"success":true}');
    };

    const { stdout, code } = await runHookSnippet(
      `api_post /api/hooks/status '{"agent_id":"a1","status":"idle"}'`
    );

    expect(code).toBe(0);
    expect(stdout).toBe('{"success":true}');
    expect(hits).toHaveLength(3);
    expect(hits[2]).toMatchObject({ url: '/api/hooks/status', body: '{"agent_id":"a1","status":"idle"}' });
  });

  it('does not retry a refusal the server actually considered', async () => {
    // A 4xx is the server having looked at the post and said no - a stale
    // session, an unknown agent. Sending it twice more changes nothing.
    behaviour = (_attempt, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"agent_id and status are required"}');
    };

    const { code } = await runHookSnippet(`api_post /api/hooks/status '{}' > /dev/null`);

    expect(code).toBe(0);
    expect(hits).toHaveLength(1);
  });

  it('gives up rather than holding the agent\'s turn open forever', async () => {
    // A hook runs inside the agent's turn and Claude Code allows it 30
    // seconds. Three attempts against a dead port, then out of the way.
    const started = Date.now();
    const { code } = await runHookSnippet(
      `api_post /api/hooks/status '{"agent_id":"a1"}' > /dev/null`,
      { DOROTHY_API_PORT: '1' },
    );

    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('reports the app as down without waiting on it', async () => {
    const down = await runHookSnippet('api_up && echo UP || echo DOWN', { DOROTHY_API_PORT: '1' });
    expect(down.stdout.trim()).toBe('DOWN');

    behaviour = (_a, res) => res.end('{"status":"ok"}');
    const up = await runHookSnippet('api_up && echo UP || echo DOWN');
    expect(up.stdout.trim()).toBe('UP');
  });
});
