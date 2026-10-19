import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';

/**
 * POST /api/agents/:id/update, what update_agent calls (2.0.4).
 *
 * The maintainer: an orchestrator sets an agent up end to end, on any CLI, and
 * changes its settings afterwards. create_agent took provider, model, effort,
 * permission mode and CLI path; after that only the window could change an
 * agent (agent:update). The route takes the window's path, shared
 * (core/agent-update.ts), and adds what an orchestrator calling it needs: who
 * may, the checks create_agent makes, and an answer saying when the change
 * applies and whether the conversation is kept.
 *
 * How it fails, written before the code (2026-10-19):
 *
 * Who may
 * 1. A call that names nobody (the shared token) changes an agent.
 * 2. A worker changes another agent's settings, or its own: it must be refused
 *    as handing work is (worker_may_not_update), with nothing written.
 * 3. The orchestrator changes an agent of another project, allowCrossProject or
 *    not: there is no way round it here (other_project), nothing written.
 * 4. An orchestrator's settings change over the API: its own, or any by Tars's
 *    pass. They are the window's (orchestrator_settings): its chats run on them.
 * 5. The callers that may are refused: the project's orchestrator on one of its
 *    workers, and Tars's own pass.
 * 6. A chat's runner is changed: its settings are its orchestrator's
 *    (orchestrator_settings too).
 *
 * What may change
 * 7. role or orchestratorMode makes or unmakes an orchestrator over the API.
 * 8. projectPath moves an agent into another project.
 * 9. A field the route does not take (a worktree, a typo) is dropped, and the
 *    answer says the agent was updated.
 * 10. An update that names nothing answers that it updated the agent.
 * 11. A value create_agent refuses is taken here: an unknown provider, a
 *     permission mode, an effort, a model name, a CLI path that is no
 *     executable file, a skill name, an empty name or one with ", task t-",
 *     plan on a provider without plan mode, a key provider without its key.
 * 12. A value of the wrong type reaches the record (skills as a string).
 *
 * When it applies (a running turn is never cut)
 * 13. A change of provider or CLI path while a CLI runs, or starts, in the
 *     agent's terminal ends that terminal and whatever it was doing: it must be
 *     refused (cli_running), with nothing written and the terminal alive.
 * 14. A change of provider keeps the model and the CLI path, which named the
 *     old CLI's: the next start runs claude on a codex model, or the codex
 *     binary for a claude agent.
 * 15. ...or drops the model and CLI path given with it.
 * 16. The answer does not say when the change applies, nor whether the
 *     conversation is kept, or says it wrong:
 *     a. claude, its CLI up and free: restarted now, on its conversation;
 *     b. claude in a turn: restarted once the turn ends, the turn not cut;
 *     c. codex up: at its next start, a new conversation, its terminal alive;
 *     d. no CLI up: at its next start, which continues the last conversation
 *        only on its first start since Tars opened;
 *     e. a change of CLI: at its next start, on a new conversation, even with
 *        an older conversation of the new CLI on disk;
 *     f. a name or skills only: now, nothing restarted.
 */

const mockPtyProcess = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };

vi.mock('node-pty', () => ({ spawn: vi.fn(() => mockPtyProcess) }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  endTerminalTree: vi.fn(async (t: { kill?: () => void }) => { t.kill?.(); }),
}));

vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

// What the restart module answers is set by each case: the module itself, its
// waits and its relaunch, is held by agent-restart's own tests and by the E2E.
vi.mock('../../../../electron/core/agent-restart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/core/agent-restart')>()),
  restartForSettings: vi.fn(() => ({ action: 'next-launch', why: 'no CLI is running in its terminal' })),
}));

// The CLIs a cliPath names, on a POSIX disk in memory: this file runs as darwin
// or linux on every host (below).
const cliDisk = vi.hoisted(() => new Map<string, PosixEntry>());
vi.mock('fs', async (importOriginal) => (await import('../../platform/posix-fake-disk')).onPosixDisk(await importOriginal<typeof import('fs')>(), cliDisk));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';
import { POSIX_ROOT, type PosixEntry } from '../../platform/posix-fake-disk';
import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { restartForSettings } from '../../../../electron/core/agent-restart';
import { consumeResumeSessionId, resetResumeTracking, transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

const PROJECT = '/test/project';
const CODEX_BIN = `${POSIX_ROOT}/codex`;
const CLAUDE_BIN = `${POSIX_ROOT}/claude`;

/** A terminal with a CLI up in it, opened the way every agent terminal is (cliRunningIn reads what spawnAgentPty recorded). */
function liveCli(ptyId: string, binaryName: string) {
  const terminal = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), process: binaryName };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName, shell: '/bin/bash', args: ['-l'], cwd: PROJECT, cols: 80, rows: 24, env: {} });
  ptyProcesses.set(ptyId, terminal as never);
  return terminal;
}

/** A terminal where the shell waits and no CLI runs. */
function bareShell(ptyId: string) {
  const terminal = { write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), process: 'bash' };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: PROJECT, cols: 80, rows: 24, env: {} });
  ptyProcesses.set(ptyId, terminal as never);
  return terminal;
}

function agent(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    id: 'x', status: 'idle', projectPath: PROJECT, skills: [], output: [], lastActivity: new Date().toISOString(),
    ...overrides,
  } as AgentStatus;
}

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

let ctx: RouteContext;
let settings: AppSettings;

type Caller = { callerAgentId?: string; internal?: boolean };

/** The route, called as `caller` (the lead by default), and its answer. */
async function update(id: string, body: Record<string, unknown>, caller: Caller = { callerAgentId: 'lead' }) {
  const app = makeRouteApp();
  registerAgentRoutes(app, ctx);
  const route = app.routes.find(r => r.method === 'POST' && String(r.pattern).includes('\\/update$'));
  expect(route, 'POST /api/agents/:id/update is registered').toBeDefined();
  const sendJson = vi.fn();
  const req = {
    method: 'POST', pathname: `/api/agents/${id}/update`, url: new URL(`http://localhost/api/agents/${id}/update`),
    body, raw: {} as never, res: {} as never, params: { id }, ...caller,
  } as RouteRequest;
  await route!.handler(req, sendJson, ctx);
  expect(sendJson).toHaveBeenCalledTimes(1);
  const [answer, status] = sendJson.mock.calls[0] as [Record<string, unknown>, number | undefined];
  return { answer, status: status ?? 200 };
}

/** Every field of the record but what a clock or a counter moves: what "nothing written" compares. */
const recordOf = (id: string) => {
  const { lastActivity: _l, ...rest } = agents.get(id)!;
  return JSON.parse(JSON.stringify(rest));
};

beforeEach(() => {
  resetLaunches();
  resetResumeTracking();
  agents.clear();
  ptyProcesses.clear();
  cliDisk.clear();
  cliDisk.set(POSIX_ROOT, { kind: 'dir', mode: 0o755 });
  cliDisk.set(CODEX_BIN, { kind: 'file', mode: 0o755 });
  cliDisk.set(CLAUDE_BIN, { kind: 'file', mode: 0o755 });
  cliDisk.set(`${POSIX_ROOT}/notes.txt`, { kind: 'file', mode: 0o644 });
  vi.mocked(saveAgents).mockClear();
  vi.mocked(restartForSettings).mockClear();
  vi.mocked(restartForSettings).mockImplementation(() => ({ action: 'next-launch', why: 'no CLI is running in its terminal' }));

  settings = {} as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: settings,
    getAppSettings: () => settings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: new EventEmitter(),
  };

  agents.set('lead', agent({ id: 'lead', name: 'Lead', role: 'orchestrator' }));
  agents.set('w1', agent({ id: 'w1', name: 'Coder', role: 'worker', provider: 'codex', model: 'gpt-old', cliPath: CODEX_BIN }));
  agents.set('w2', agent({ id: 'w2', name: 'Tester', role: 'worker', provider: 'claude', model: 'sonnet' }));
  agents.set('far', agent({ id: 'far', name: 'Far', role: 'worker', projectPath: '/other/project' }));
  agents.set('far-lead', agent({ id: 'far-lead', name: 'Far lead', role: 'orchestrator', projectPath: '/other/project' }));
  agents.set('runner', agent({ id: 'runner', name: 'Main', role: 'worker', kind: 'chat', chatId: 'c1' } as Partial<AgentStatus>));
});

describe('who may change an agent', () => {
  it('1. refuses a call that names nobody', async () => {
    const before = recordOf('w2');
    const { status } = await update('w2', { model: 'opus' }, {});
    expect(status).toBe(403);
    expect(recordOf('w2')).toEqual(before);
  });

  it('2. refuses a worker, on another agent and on itself, with worker_may_not_update', async () => {
    for (const id of ['w2', 'w1']) {
      const before = recordOf(id);
      const { answer, status } = await update(id, { model: 'opus' }, { callerAgentId: 'w1' });
      expect(status).toBe(403);
      expect(answer.code).toBe('worker_may_not_update');
      expect(String(answer.error)).toMatch(/orchestrator/);
      expect(recordOf(id)).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it('3. refuses an agent of another project, whatever allowCrossProject says', async () => {
    for (const body of [{ model: 'opus' }, { model: 'opus', allowCrossProject: true }]) {
      const { answer, status } = await update('far', body);
      expect(status).toBe(403);
      expect(answer.code).toBe('other_project');
    }
    expect(agents.get('far')!.model).toBeUndefined();
  });

  it("4. refuses the orchestrator's own settings, and any orchestrator's, Tars's pass included", async () => {
    const own = await update('lead', { model: 'opus' });
    expect(own.status).toBe(403);
    expect(own.answer.code).toBe('orchestrator_settings');
    expect(String(own.answer.error)).toMatch(/Agents page/);
    const far = await update('far-lead', { model: 'opus' }, { internal: true });
    expect(far.status).toBe(403);
    expect(far.answer.code).toBe('orchestrator_settings');
    expect(agents.get('lead')!.model).toBeUndefined();
    expect(agents.get('far-lead')!.model).toBeUndefined();
  });

  it("5. lets the project's orchestrator change one of its workers, and Tars's own pass any worker", async () => {
    expect((await update('w2', { model: 'opus' })).status).toBe(200);
    expect(agents.get('w2')!.model).toBe('opus');
    expect((await update('far', { name: 'Far away' }, { internal: true })).status).toBe(200);
    expect(agents.get('far')!.name).toBe('Far away');
  });

  it("6. refuses a chat's runner: its settings are its orchestrator's", async () => {
    for (const caller of [{ callerAgentId: 'lead' }, { internal: true }]) {
      const { answer, status } = await update('runner', { model: 'opus' }, caller);
      expect(status).toBe(403);
      expect(answer.code).toBe('orchestrator_settings');
    }
    expect(agents.get('runner')!.model).toBeUndefined();
  });
});

describe('what may change', () => {
  it('7. refuses role and orchestratorMode: an orchestrator is made in the Agents page', async () => {
    for (const body of [{ role: 'orchestrator' }, { role: 'worker' }, { orchestratorMode: true }]) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', { ...body, model: 'opus' });
      expect(status).toBe(403);
      expect(String(answer.error)).toMatch(/Agents page/);
      expect(recordOf('w2')).toEqual(before);
    }
  });

  it('8. refuses projectPath: an agent does not move to another project over the API', async () => {
    const { status } = await update('w2', { projectPath: '/other/project' });
    expect(status).toBe(403);
    expect(agents.get('w2')!.projectPath).toBe(PROJECT);
  });

  it('9. refuses a field it does not take, naming the fields it does', async () => {
    for (const body of [{ worktree: { enabled: true, branchName: 'x' } }, { modle: 'opus' }, { savedPrompt: 'go' }]) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', body);
      expect(status).toBe(400);
      expect(String(answer.error)).toMatch(/provider/);
      expect(String(answer.error)).toMatch(/effort/);
      expect(recordOf('w2')).toEqual(before);
    }
  });

  it('10. refuses an update that names nothing', async () => {
    const { status } = await update('w2', {});
    expect(status).toBe(400);
  });

  it('11. refuses what create_agent refuses, and writes nothing', async () => {
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ provider: 'gpt-everything' }, /Unknown provider/],
      [{ permissionMode: 'yolo' }, /permission mode/i],
      [{ effort: 'extreme' }, /effort/i],
      [{ model: 'opus; rm -rf ~' }, /model/i],
      [{ cliPath: 'codex' }, /absolute/i],
      [{ cliPath: `${POSIX_ROOT}/notes.txt` }, /cliPath/],
      [{ skills: ['../../etc'] }, /skill/],
      [{ name: '' }, /name/i],
      [{ name: 'Coder, task t-1a2b3c4d' }, /task t-/],
      [{ provider: 'codex', permissionMode: 'plan' }, /no plan mode/],
      [{ provider: 'deepseek' }, /No API key configured for provider "deepseek"/],
    ];
    for (const [body, why] of refused) {
      const before = recordOf('w2');
      const { answer, status } = await update('w2', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(String(answer.error), JSON.stringify(body)).toMatch(why);
      expect(recordOf('w2'), JSON.stringify(body)).toEqual(before);
    }
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it('11. takes a key provider once its key is set', async () => {
    settings.deepSeekApiKey = 'sk-test-not-a-real-key';
    const { status } = await update('w2', { provider: 'deepseek' });
    expect(status).toBe(200);
    expect(agents.get('w2')!.provider).toBe('deepseek');
  });

  it('12. refuses a value of the wrong type', async () => {
    for (const body of [{ skills: 'react' }, { model: 42 }, { name: ['x'] }, { effort: true }]) {
      const before = recordOf('w2');
      const { status } = await update('w2', body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(recordOf('w2')).toEqual(before);
    }
  });
});

describe('when it applies: a running turn is never cut', () => {
  afterEach(() => {
    fs.rmSync(path.join(os.homedir(), '.claude'), { recursive: true, force: true });
  });

  it('13. refuses a change of CLI while a CLI runs or starts in the terminal, and leaves it alone', async () => {
    const terminal = liveCli('pty-w1', 'codex');
    agents.get('w1')!.ptyId = 'pty-w1';
    agents.get('w1')!.status = 'running';
    for (const body of [{ provider: 'claude' }, { cliPath: CLAUDE_BIN }, { provider: 'claude', model: 'opus' }]) {
      const before = recordOf('w1');
      const { answer, status } = await update('w1', body);
      expect(status, JSON.stringify(body)).toBe(409);
      expect(answer.code).toBe('cli_running');
      expect(String(answer.error)).toMatch(/stop_agent/);
      expect(recordOf('w1')).toEqual(before);
    }
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(ptyProcesses.get('pty-w1')).toBe(terminal);
  });

  it('14. a change of provider clears the model and CLI path of the old CLI', async () => {
    const { answer, status } = await update('w1', { provider: 'claude' });
    expect(status).toBe(200);
    const record = agents.get('w1')!;
    expect(record.provider).toBe('claude');
    expect(record.model).toBeUndefined();
    expect(record.cliPath).toBeUndefined();
    expect(answer.changed).toEqual(expect.arrayContaining(['provider', 'model', 'cliPath']));
  });

  it('15. a change of provider keeps the model, effort and CLI path given with it', async () => {
    const { status } = await update('w1', { provider: 'claude', model: 'opus', effort: 'high', cliPath: CLAUDE_BIN });
    expect(status).toBe(200);
    expect(agents.get('w1')).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', cliPath: CLAUDE_BIN });
  });

  it('16a. claude up and free: restarted now, on its conversation', async () => {
    liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', resumableSessionId: '11111111-2222-3333-4444-555555555555' });
    vi.mocked(restartForSettings).mockReturnValueOnce({ action: 'restarted' });
    const { answer, status } = await update('w2', { model: 'opus', effort: 'max' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'now', session: 'kept' });
    expect(String(answer.text)).toMatch(/same conversation/);
    expect(vi.mocked(restartForSettings).mock.calls[0]).toEqual(['w2', ['model', 'effort']]);
  });

  it('16b. claude in a turn: restarted once the turn ends, the turn not cut', async () => {
    const terminal = liveCli('pty-w2', 'claude');
    Object.assign(agents.get('w2')!, { ptyId: 'pty-w2', status: 'running', resumableSessionId: '11111111-2222-3333-4444-555555555555' });
    vi.mocked(restartForSettings).mockReturnValueOnce({ action: 'waiting', for: 'turn' });
    const { answer, status } = await update('w2', { effort: 'low' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'when-free', waitingFor: 'turn', session: 'kept' });
    expect(String(answer.text)).toMatch(/turn ends/);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(agents.get('w2')!.effort).toBe('low');
  });

  it('16c. codex up: at its next start, on a new conversation, its terminal alive', async () => {
    const terminal = liveCli('pty-w1', 'codex');
    Object.assign(agents.get('w1')!, { ptyId: 'pty-w1', status: 'running' });
    vi.mocked(restartForSettings).mockReturnValueOnce({ action: 'next-launch', why: 'its CLI does not report the end of a turn' });
    const { answer, status } = await update('w1', { model: 'gpt-new', effort: 'high' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'next-start', session: 'new' });
    expect(String(answer.text)).toMatch(/next start/);
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(agents.get('w1')).toMatchObject({ model: 'gpt-new', effort: 'high', ptyId: 'pty-w1' });
  });

  it('16d. no CLI up: at its next start, which continues the conversation only on the first start since Tars opened', async () => {
    const session = '11111111-2222-3333-4444-555555555555';
    agents.get('w2')!.resumableSessionId = session;
    const transcript = transcriptPath(PROJECT, session);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');

    const first = await update('w2', { model: 'opus' });
    expect(first.answer).toMatchObject({ applies: 'next-start', session: 'kept' });

    expect(consumeResumeSessionId(agents.get('w2')!)).toBe(session); // that first start
    const later = await update('w2', { model: 'haiku' });
    expect(later.answer).toMatchObject({ applies: 'next-start', session: 'new' });
  });

  it('16e. a change of CLI: at its next start, on a new conversation, even with an older one of the new CLI on disk', async () => {
    const session = '11111111-2222-3333-4444-555555555555';
    const shell = bareShell('pty-w1');
    Object.assign(agents.get('w1')!, { ptyId: 'pty-w1', resumableSessionId: session });
    const transcript = transcriptPath(PROJECT, session);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');

    const { answer, status } = await update('w1', { provider: 'claude', model: 'opus' });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'next-start', session: 'new' });
    expect(String(answer.text)).toMatch(/new conversation/);
    // The shell it waited in had the old CLI's environment: ended, as the window ends it.
    expect(shell.kill).toHaveBeenCalled();
    expect(consumeResumeSessionId(agents.get('w1')!)).toBeNull();
  });

  it('16f. a name or skills only: applied now, nothing restarted', async () => {
    liveCli('pty-w2', 'claude');
    agents.get('w2')!.ptyId = 'pty-w2';
    vi.mocked(restartForSettings).mockImplementation((_id, changed) => (changed.length === 0
      ? { action: 'next-launch', why: 'nothing the CLI reads at launch changed' }
      : { action: 'restarted' }));
    const { answer, status } = await update('w2', { name: 'Reviewer', skills: ['react'] });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ applies: 'now', session: 'kept' });
    expect(agents.get('w2')).toMatchObject({ name: 'Reviewer', skills: ['react'] });
    expect(vi.mocked(restartForSettings).mock.calls.filter(([, changed]) => changed.length > 0)).toEqual([]);
  });

  it('answers with the agent as GET /api/agents/:id shows it, without its output buffer', async () => {
    agents.get('w2')!.output = ['chunk-1', 'chunk-2'];
    const { answer } = await update('w2', { model: 'opus' });
    const shown = answer.agent as Record<string, unknown>;
    expect(shown).toMatchObject({ id: 'w2', model: 'opus', outputChunks: 2 });
    expect(shown.output).toBeUndefined();
  });
});
