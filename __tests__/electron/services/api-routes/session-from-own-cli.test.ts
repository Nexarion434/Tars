import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What the hooks route does with a CLI that is not the agent's terminal's (the
 * Audit's L3 and L4 on #380).
 *
 * How it fails, written before the code:
 * 1. (L4) An agent whose own SessionStart was lost or refused has no owner,
 *    and the registration fallback adopts the first session posting a status:
 *    a nested claude's, whose hooks carry the agent's id and token. It must
 *    adopt only a post whose CLI is the terminal's (X-Tars-Cli-Pid, sent with
 *    every hook post), and, as everywhere, any post that names no CLI.
 * 2. (L3) A refused registration is one console line: a wrong refusal reads as
 *    an agent stuck in its last status, with nothing for a person to find. It
 *    is written into the agent's kept output, which Logs shows.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() }, BrowserWindow: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn(), rememberTerminalOwner: vi.fn(), noteSubmitted: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { agents } from '../../../../electron/core/agent-manager';
import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';
import { sid } from '../../../fixtures/session-id';

const TERMINAL = 4242;
/** A pid no process has: its parent cannot be read, so it is not the terminal's child. */
const NESTED = 3_999_999;

function app(): RouteApp {
  const routes: Array<{ method: string; pattern: string | RegExp; handler: (req: RouteRequest, send: unknown) => unknown }> = [];
  const add = (method: string) => (pattern: string | RegExp, handler: (req: RouteRequest, send: unknown) => unknown) => { routes.push({ method, pattern, handler }); };
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), patch: add('PATCH') } as unknown as RouteApp;
}
const ctx = {
  mainWindow: null, appSettings: {}, getAppSettings: () => ({}), getTelegramBot: () => null, getSlackApp: () => null,
  slackResponseChannel: null, slackResponseThreadTs: null, handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
  initAgentPtyCallback: vi.fn(async () => 'x'), agentStatusEmitter: { emit: vi.fn(), on: vi.fn() },
} as unknown as RouteContext;

function post(a: RouteApp, body: Record<string, unknown>, cliPid?: number): Record<string, unknown> {
  const route = (a as unknown as { routes: Array<{ pattern: unknown; handler: (req: RouteRequest, send: unknown) => unknown }> }).routes.find((r) => r.pattern === '/api/hooks/status')!;
  let answer: Record<string, unknown> = {};
  const raw = { headers: cliPid === undefined ? {} : { 'x-tars-cli-pid': String(cliPid) } };
  route.handler({ body, params: {}, raw } as unknown as RouteRequest, ((payload: Record<string, unknown>) => { answer = payload; }) as never);
  return answer;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  const a = { id: 'a1', name: 'Worker', status: 'running', ptyId: 'pty-a1', output: [], projectPath: '/p', skills: [], ...over } as AgentStatus;
  agents.set(a.id, a);
  ptyProcesses.set('pty-a1', { pid: TERMINAL, write: vi.fn(), kill: vi.fn() } as never);
  return a;
}

beforeEach(() => { agents.clear(); ptyProcesses.clear(); });

describe('an agent nobody owns, and the first status posted for it', () => {
  it("1. is not adopted by a CLI that is not its terminal's", async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'running', event: 'UserPromptSubmit' }, NESTED);
    await settle();
    expect(a.currentSessionId).toBeUndefined();
    expect(a.resumableSessionId).toBeUndefined();
  });

  it("1. is adopted by its terminal's own CLI", async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('own'), status: 'running', event: 'UserPromptSubmit' }, TERMINAL);
    await settle();
    expect(a.currentSessionId).toBe(sid('own'));
  });

  it('1. is adopted, as before, by a post that names no CLI', async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('gemini'), status: 'running' });
    await settle();
    expect(a.currentSessionId).toBe(sid('gemini'));
  });
});

describe('a registration refused', () => {
  it('2. is said in the agent\'s kept output, which Logs shows', async () => {
    const a = agent({ currentSessionId: sid('own'), resumableSessionId: sid('own') });
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'idle', source: 'startup', cli_pid: String(NESTED) });
    await settle();
    expect(a.currentSessionId).toBe(sid('own'));
    expect(a.output.join('')).toMatch(/\[Tars\].*refused.*not this terminal's/i);
  });
});
