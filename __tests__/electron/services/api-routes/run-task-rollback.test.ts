import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * A delegation that never happened must not leave a task on the agent's card.
 *
 * POST /api/agents/:id/run-task wrote `status='running'`, `currentTask` and
 * `lastActivity` before awaiting the ACP turn, and put none of them back when
 * the turn failed. An ACP turn runs beside the terminal rather than in it:
 * nothing is typed into the PTY, so when it fails there is no trace of the
 * task anywhere except those three fields. The result was the exact thing
 * seen in production - an orchestrator told its task was assigned, an agent
 * sitting at an empty prompt with `currentTask` set and `secondsSinceActivity`
 * climbing, and no error anywhere to say the two did not match.
 */

const mockPtyProcess = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPtyProcess) }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({ app: { getPath: () => '/Users/test' }, BrowserWindow: vi.fn() }));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({
  buildFullPath: vi.fn(() => '/usr/bin'),
}));

vi.mock('../../../../electron/services/acp/delegate', () => ({
  canDelegateOverAcp: vi.fn(() => true),
  delegateOverAcp: vi.fn(),
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { delegateOverAcp } from '../../../../electron/services/acp/delegate';
import { hasAcpTurn } from '../../../../electron/services/agent-liveness';
import { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  } as RouteApp;
  return app;
}

const EARLIER = '2026-08-25T09:00:00.000Z';

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: EARLIER,
    ...overrides,
  };
}

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'POST',
    pathname: '',
    url: new URL('http://localhost/'),
    body: {},
    raw: {} as never,
    res: {} as never,
    params: { id: 'agent-1' },
    headers: {},
    ...overrides,
  } as RouteRequest;
}

let ctx: RouteContext;
let app: RouteApp;

function runTaskHandler() {
  return app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('run-task'))!.handler;
}

beforeEach(() => {
  agents.clear();
  vi.mocked(saveAgents).mockClear();
  vi.mocked(delegateOverAcp).mockReset();

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  } as unknown as RouteContext;

  app = makeRouteApp();
  registerAgentRoutes(app, ctx);
});

describe('POST /api/agents/:id/run-task', () => {
  it('takes the task back off the agent when the ACP turn throws', async () => {
    const agent = makeAgent({ status: 'idle', currentTask: undefined });
    agents.set('agent-1', agent);
    vi.mocked(delegateOverAcp).mockRejectedValue(new Error('socket hang up'));

    const sent: Array<{ body: unknown; status?: number }> = [];
    await runTaskHandler()(
      makeReq({ body: { task: 'refactor the parser', timeoutSeconds: 300 } }),
      (body, status) => sent.push({ body, status }),
    );

    // Nothing ran, so nothing is on the card and nothing is running.
    expect(agent.status).toBe('idle');
    expect(agent.currentTask).toBeUndefined();
    expect(agent.lastActivity).toBe(EARLIER);

    expect(sent[0].status).toBe(502);
    expect(sent[0].body).toMatchObject({ ok: false, retryWithDispatch: true });
    expect(String((sent[0].body as { error: string }).error)).toContain('socket hang up');
  });

  it('restores the previous task rather than blanking it', async () => {
    // An agent already carrying work, handed a second task that fails to
    // start: the first one is still what it is doing.
    const agent = makeAgent({ status: 'running', currentTask: 'the task it already had' });
    agents.set('agent-1', agent);
    vi.mocked(delegateOverAcp).mockRejectedValue(new Error('boom'));

    await runTaskHandler()(makeReq({ body: { task: 'a second task' } }), () => {});

    expect(agent.currentTask).toBe('the task it already had');
    expect(agent.status).toBe('running');
  });

  it('takes the task back when the turn reports failure instead of throwing', async () => {
    const agent = makeAgent({ status: 'idle' });
    agents.set('agent-1', agent);
    vi.mocked(delegateOverAcp).mockResolvedValue({
      ok: false,
      transport: 'acp',
      text: 'I could not start',
      toolCalls: [],
      error: 'timed out',
    });

    const sent: Array<{ body: unknown; status?: number }> = [];
    await runTaskHandler()(
      makeReq({ body: { task: 'refactor the parser' } }),
      (body, status) => sent.push({ body, status }),
    );

    expect(agent.currentTask).toBeUndefined();
    expect(agent.status).toBe('idle');
    // Whatever it did manage to say is still worth keeping.
    expect(agent.lastCleanOutput).toBe('I could not start');
    expect(sent[0].status).toBe(502);
  });

  it('keeps the result of a turn that worked', async () => {
    const agent = makeAgent({ status: 'idle' });
    agents.set('agent-1', agent);
    vi.mocked(delegateOverAcp).mockResolvedValue({
      ok: true,
      transport: 'acp',
      text: 'done, here is the diff',
      toolCalls: ['Edit'],
      stopReason: 'end_turn',
    });

    const sent: Array<{ body: unknown; status?: number }> = [];
    await runTaskHandler()(
      makeReq({ body: { task: 'refactor the parser' } }),
      (body, status) => sent.push({ body, status }),
    );

    expect(agent.status).toBe('idle');
    expect(agent.lastCleanOutput).toBe('done, here is the diff');
    expect(sent[0].status).toBe(200);
    expect(sent[0].body).toMatchObject({ ok: true, stopReason: 'end_turn' });
  });

  it('registers the turn while it runs so the liveness sweep leaves it alone', async () => {
    // An ACP turn shows no PTY activity at all. Without this register, the
    // sweep would read a healthy delegation as a ghost and idle it mid-turn.
    const agent = makeAgent({ status: 'idle' });
    agents.set('agent-1', agent);

    let seenDuringTurn: boolean | undefined;
    vi.mocked(delegateOverAcp).mockImplementation(async () => {
      seenDuringTurn = hasAcpTurn('agent-1');
      return { ok: true, transport: 'acp', text: 'ok', toolCalls: [] };
    });

    await runTaskHandler()(makeReq({ body: { task: 'x' } }), () => {});

    expect(seenDuringTurn).toBe(true);
    expect(hasAcpTurn('agent-1')).toBe(false);
  });

  it('releases the register even when the turn throws', async () => {
    const agent = makeAgent({ status: 'idle' });
    agents.set('agent-1', agent);
    vi.mocked(delegateOverAcp).mockRejectedValue(new Error('boom'));

    await runTaskHandler()(makeReq({ body: { task: 'x' } }), () => {});

    expect(hasAcpTurn('agent-1')).toBe(false);
  });
});
