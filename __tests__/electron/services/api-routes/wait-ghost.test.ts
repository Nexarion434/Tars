import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * A wait is what a ghost status costs the most.
 *
 * GET /api/agents/:id/wait holds the connection open until the status
 * changes. If the status says `running` because a hook's curl was lost, no
 * change is ever coming: the caller waits out its whole timeout, gives up,
 * and asks again. Three of those in a row is a delegation that never returns.
 *
 * So the label is checked against the process before the connection is held.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
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

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { GHOST_AFTER_MS } from '../../../../electron/services/agent-liveness';
import { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';

function makeRouteApp(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  } as RouteApp;
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'running',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

function makeReq(url: string): RouteRequest {
  return {
    method: 'GET',
    pathname: '',
    url: new URL(url),
    body: {},
    raw: new EventEmitter(),
    res: {},
    params: { id: 'agent-1' },
    headers: {},
  } as unknown as RouteRequest;
}

let app: RouteApp;

function waitHandler() {
  return app.routes.find(r => r.method === 'GET' && String(r.pattern).includes('wait'))!.handler;
}

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  app = makeRouteApp();
  registerAgentRoutes(app, {
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
  } as unknown as RouteContext);
});

describe('GET /api/agents/:id/wait against a stale status', () => {
  it('answers at once when the PTY behind a running agent is gone', async () => {
    agents.set('agent-1', makeAgent({ ptyId: 'dead-pty' }));

    const sent: unknown[] = [];
    await waitHandler()(
      makeReq('http://localhost/api/agents/agent-1/wait?timeout=300'),
      (body) => sent.push(body),
    );

    // Answered synchronously, not held for 300 seconds.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: 'idle' });
    expect(agents.get('agent-1')!.status).toBe('idle');
  });

  it('answers at once for a running agent that has been silent for too long', async () => {
    agents.set('agent-1', makeAgent({
      ptyId: 'live-pty',
      lastActivity: new Date(Date.now() - GHOST_AFTER_MS - 60_000).toISOString(),
    }));
    ptyProcesses.set('live-pty', {} as never);

    const sent: unknown[] = [];
    await waitHandler()(
      makeReq('http://localhost/api/agents/agent-1/wait?timeout=300'),
      (body) => sent.push(body),
    );

    expect(sent[0]).toMatchObject({ status: 'idle' });
  });

  it('still holds the connection open for an agent that really is working', async () => {
    agents.set('agent-1', makeAgent({ ptyId: 'live-pty' }));
    ptyProcesses.set('live-pty', {} as never);

    const sent: unknown[] = [];
    const req = makeReq('http://localhost/api/agents/agent-1/wait?timeout=300');
    await waitHandler()(req, (body) => sent.push(body));

    expect(sent).toHaveLength(0);
    expect(agents.get('agent-1')!.status).toBe('running');

    // Hang up, as a real client would, so the handler clears its timer
    // instead of leaving a five-minute one behind in the test run.
    (req.raw as unknown as EventEmitter).emit('close');
  });
});
