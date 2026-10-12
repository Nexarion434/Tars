import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveTestHome } from '../setup/test-home';

/**
 * The bundled MCP servers send the agent's token only to the Tars that started
 * its CLI, as the hooks do (tars-hook.sh; the Audit's Info on #370).
 *
 * mcp-orchestrator, mcp-memory (mcp-shared's apiRequest), mcp-kanban and
 * mcp-vault presented CLAUDE_MGR_API_TOKEN to CLAUDE_MGR_API_URL with no check.
 * A CLI that outlives a quit keeps its MCP servers, and whatever then holds the
 * port got the token with their next call.
 *
 * How it fails, written before the code:
 * 1. A port that does not prove it knows the CLI's TARS_INSTANCE_ID gets the
 *    agent's token, from any of the four servers.
 * 2. It gets the shared token from ~/.dorothy/api-token instead.
 * 3. Over-correction: the Tars that started the CLI no longer gets the token.
 * 4. The proof is asked before every call, where once proven is enough.
 * 5. A CLI Tars did not start (no token in its environment) loses the shared
 *    token it has always presented.
 * 6. A token with no TARS_INSTANCE_ID beside it is sent unproven.
 */

const INSTANCE = crypto.randomBytes(16).toString('hex');
const TOKEN = 'token-of-a1s-terminal';
const SHARED = 'the-shared-token';
let mode: 'tars' | 'squatter' = 'tars';
const received: Array<{ path: string; authorization?: string }> = [];
let server: http.Server;
let url: string;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-proof-'));
let restoreHome: () => void;
let saved: Record<string, string | undefined>;
const ENV = ['CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH'];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    received.push({ path: u.pathname, authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (u.pathname === '/api/health') {
        const instance = mode === 'tars' ? INSTANCE : 'someone-else';
        res.end(JSON.stringify({ ok: true, proof: crypto.createHash('sha256').update(`${instance}:${u.searchParams.get('challenge') ?? ''}`).digest('hex') }));
        return;
      }
      res.end(JSON.stringify({ success: true, agents: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), SHARED);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  received.length = 0;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  restoreHome = moveTestHome(home);
});
afterEach(() => {
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.resetModules();
});

/** The four servers' clients, loaded afresh: each reads its environment when it loads. */
async function clients(env: Record<string, string | undefined>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { CLAUDE_MGR_API_URL: url, CLAUDE_AGENT_ID: 'a1' }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  vi.resetModules();
  const shared = await import('../../mcp-shared/src/tars-api');
  const kanban = await import('../../mcp-kanban/src/api');
  const vault = await import('../../mcp-vault/src/utils/api');
  return [
    ['mcp-orchestrator and mcp-memory', () => shared.apiRequest('/api/agents')],
    ['mcp-kanban', () => kanban.apiRequest('GET', '/api/kanban/tasks')],
    ['mcp-vault', () => vault.apiRequest('GET', '/api/vault/documents')],
  ] as const;
}
const calls = () => received.filter((r) => r.path !== '/api/health');

describe("the MCP servers' calls to Tars", () => {
  it('1, 2. a port that does not prove the instance gets neither the token nor the shared one', async () => {
    mode = 'squatter';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE })) {
      received.length = 0;
      await call().catch(() => undefined);
      expect(calls().map((r) => r.authorization), name).toEqual([undefined]);
    }
  });

  it('3, 4. the Tars that started the CLI gets the token, proven once per server', async () => {
    mode = 'tars';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE })) {
      received.length = 0;
      await call();
      await call();
      expect(calls().map((r) => r.authorization), name).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
      expect(received.filter((r) => r.path === '/api/health').length, `${name}: proven once`).toBeLessThanOrEqual(1);
    }
  });

  it('5. a CLI Tars did not start presents the shared token, as before, unasked', async () => {
    mode = 'squatter';
    const [[, orchestrator], , [, vault]] = await clients({ CLAUDE_MGR_API_TOKEN: undefined, TARS_INSTANCE_ID: undefined });
    await orchestrator();
    await vault();
    expect(calls().map((r) => r.authorization)).toEqual([`Bearer ${SHARED}`, `Bearer ${SHARED}`]);
    expect(received.some((r) => r.path === '/api/health')).toBe(false);
  });

  it('6. a token with no instance id beside it is not sent', async () => {
    mode = 'tars';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: undefined })) {
      received.length = 0;
      await call().catch(() => undefined);
      expect(calls().map((r) => r.authorization), name).toEqual([undefined]);
    }
  });
});
