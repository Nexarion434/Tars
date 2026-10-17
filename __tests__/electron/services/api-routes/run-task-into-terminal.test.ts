import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * delegate_task gives the task to the agent's own permanent terminal (2.0.4,
 * the maintainer's decision of 2026-10-18): POST /api/agents/:id/run-task
 * types it into the session its card shows, or starts that session with it,
 * and GET /api/tasks/:id follows it to its end, read from that session. No run
 * over ACP is opened to delegate any more.
 *
 * The route, the one-task queue, the dispatch, the real task ledger and the
 * real task watch; only node-pty is replaced, by a terminal that records what
 * is typed into it, and the CLI's hooks by the calls they make (a turn begins,
 * the agent rests) and the transcript Claude Code writes.
 *
 * Every way it can fail, written before the code:
 *  D1. The task is not typed into the terminal the agent's card shows: a run
 *      over ACP is opened, or a second terminal is spawned beside the first.
 *  D2. It is typed without the asker's line and its task id, so the agent
 *      cannot tell who asked, and the turn cannot be told apart.
 *  D3. With `answer: 'started'` the caller is not answered at once with a task
 *      id it can follow, or is answered `running` before any turn began.
 *  D4. Followed by that id, the task is not `starting` before its turn, nor
 *      the ledger's task from its turn on, nor its end once the agent rests.
 *  D5. The answer is the hooks' copy, cut at 4000 bytes, or the session's
 *      earlier conversation, not the transcript's final message for the task
 *      in full; why it ended is missing.
 *  D6. A turn interrupted (Esc, stop task) never ends the task: Claude Code
 *      sends no Stop for it. Or it ends as `completed`.
 *  D7. A turn that fails ends as completed, or without what the CLI said.
 *  D8. A second task given while the first works goes into the turn in hand,
 *      or is typed before the first's answer was read, which is then the
 *      second's.
 *  D9. The asker following its task by its id is also told its end in its own
 *      terminal: the same answer twice, a turn spent reading it.
 *  D10. A task the terminal refuses (a permission dialog is open) is followed
 *      for ever as `starting`, and the queue stays held.
 *  D11. A model asked for one task is said taken while the agent's session was
 *      already open, which a model cannot change.
 *  D12. A CLI whose turns Tars cannot see (no hook: codex, opencode, amp, pi,
 *      grok) is followed for ever, or said to have answered what it did not.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-task-terminal-'));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Typed = { ptyId: string; data: string; taskRef?: string; sender?: { kind: string; id?: string } };
const typed: Typed[] = [];
/** What the terminal does with a message: written at once, or refused. */
let writeOutcome: 'written' | 'refused' = 'written';
vi.mock('../../../../electron/core/pty-manager', async (original) => {
  const real = await original<typeof import('../../../../electron/core/pty-manager')>();
  return {
    ...real,
    ptyProcesses: new Map(),
    writeProgrammaticInput: vi.fn((pty: { id: string }, data: string, _bp: boolean, origin?: { taskRef?: string; sender?: Typed['sender']; onWritten?: () => void }) => {
      if (writeOutcome === 'refused') return 'refused';
      typed.push({ ptyId: pty.id, data, taskRef: origin?.taskRef, sender: origin?.sender });
      origin?.onWritten?.();
      return 'written';
    }),
  };
});
vi.mock('../../../../electron/core/agent-pty', async (original) => ({
  ...(await original<typeof import('../../../../electron/core/agent-pty')>()),
  cliRunningIn: (p: unknown) => !!p,
  spawnAgentPty: vi.fn(() => { throw new Error('no second terminal'); }),
}));
const acpRuns: unknown[] = [];
vi.mock('../../../../electron/services/acp/delegate', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/acp/delegate')>()),
  canDelegateOverAcp: () => true,
  delegateOverAcp: async (opts: unknown) => { acpRuns.push(opts); return { ok: true, started: true, text: 'over ACP' }; },
}));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { noteTurn, liveTaskLedger } from '../../../../electron/services/task-ledger';
import { startTaskWatch, stopTaskWatch } from '../../../../electron/services/task-watch';
import { emitAgentStatus } from '../../../../electron/services/agent-events';
import { transcriptPath } from '../../../../electron/utils/resume-session';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let routes: RouteApp;
let ledgerDir: string;

beforeEach(() => {
  typed.length = 0;
  acpRuns.length = 0;
  writeOutcome = 'written';
  agents.clear();
  (ptyProcesses as Map<string, unknown>).clear();
  ledgerDir = fs.mkdtempSync(path.join(tmp, 'ledger-'));
  startTaskWatch(path.join(ledgerDir, 'l.jsonl'), path.join(ledgerDir, 't.jsonl'), path.join(ledgerDir, 'r.jsonl'));
  routes = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerAgentRoutes(routes, {
    mainWindow: null,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({}) as AppSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'unused'),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext);
});

afterEach(() => {
  stopTaskWatch();
});

type Answer = { data: Record<string, unknown>; status: number };
function call(method: 'GET' | 'POST', url: string, callerAgentId: string, body?: Record<string, unknown>) {
  const u = new URL(`http://localhost${url}`);
  const route = routes.routes.find(r => r.method === method && typeof r.pattern !== 'string' && r.pattern.test(u.pathname))!;
  const match = (route.pattern as RegExp).exec(u.pathname)!;
  let got: Answer | undefined;
  let settle!: (a: Answer) => void;
  const answer = new Promise<Answer>((resolve) => { settle = resolve; });
  const req = {
    method, pathname: u.pathname, url: u, body: body ?? {},
    raw: { headers: {}, on: () => {} }, res: {}, params: { id: match[1] }, callerAgentId,
  } as unknown as RouteRequest;
  void route.handler(req, (data, status = 200) => {
    if (got) return;
    got = { data: data as Record<string, unknown>, status };
    settle(got);
  }, {} as RouteContext);
  return { answer, answered: () => got };
}

const project = () => {
  const p = path.join(tmp, 'project');
  fs.mkdirSync(p, { recursive: true });
  return p;
};

/** An agent whose CLI runs in its terminal, at its prompt, in session `sid`. */
function liveAgent(id: string, over: Partial<AgentStatus> = {}): AgentStatus {
  const ptyId = `pty-${id}`;
  (ptyProcesses as Map<string, unknown>).set(ptyId, { id: ptyId, pid: 4242, write: vi.fn(), onExit: vi.fn(), onData: vi.fn() });
  const agent = {
    id, name: id, status: 'waiting', waitingReason: 'idle', provider: 'claude', projectPath: project(),
    skills: [], output: [], lastActivity: new Date().toISOString(), ptyId, currentSessionId: `sid-${id}`,
    ...over,
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

function orchestrator(): AgentStatus {
  const lead = { id: 'lead', name: 'Lead', status: 'running', role: 'orchestrator', provider: 'claude', projectPath: project(), skills: [], output: [], lastActivity: new Date().toISOString() } as AgentStatus;
  agents.set('lead', lead);
  return lead;
}

/** The transcript line Claude Code writes for a reply. */
function reply(agent: AgentStatus, text: string, at = Date.now()) {
  const file = transcriptPath(agent.projectPath, agent.currentSessionId!, os.homedir());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id: `m-${at}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } }) + '\n');
}

/** What the CLI's hooks do around a turn: UserPromptSubmit, then the rest it comes to. */
function turnBegins(agent: AgentStatus, prompt: string) {
  agent.status = 'running';
  noteTurn(agent, { sessionId: agent.currentSessionId, text: prompt });
  emitAgentStatus(agent.id);
}
function rests(agent: AgentStatus, status: 'idle' | 'error' = 'idle', error?: string) {
  agent.status = status;
  if (error) agent.error = error;
  emitAgentStatus(agent.id);
}

const until = async (what: () => unknown, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The envelope a sender line carries, as the real writer types it. */
const promptOf = (t: Typed) => (t.taskRef ? `Message from agent "Lead" ("lead"), task ${t.taskRef}: ${t.data}` : t.data);

describe('a task delegated into the agent\'s own terminal', () => {
  it('(D1, D2, D3) is typed into the terminal its card shows, under its asker\'s line, and answered at once with an id to follow', async () => {
    orchestrator();
    liveAgent('dev');
    const run = call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' });
    const { data, status } = await run.answer;
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, queued: false, outcome: 'starting' });
    expect(String(data.taskId)).toMatch(/^t-[0-9a-f]{8}$/);
    await until(() => typed.length === 1);
    expect(typed[0]).toMatchObject({ ptyId: 'pty-dev', data: 'review the notes', taskRef: data.taskId, sender: { kind: 'agent', id: 'lead' } });
    expect(acpRuns).toHaveLength(0);
  });

  it('(D4, D5) followed by its id: starting, then the ledger\'s task, then its end with the transcript\'s final message in full', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'review the notes', answer: 'started' }).answer;
    const ref = String(data.taskId);
    await until(() => typed.length === 1);
    expect((await call('GET', `/api/tasks/${ref}`, 'lead').answer).data.task).toMatchObject({ id: ref, outcome: 'starting' });

    reply(dev, 'an answer to an earlier task', Date.now() - 60_000);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    const running = (await call('GET', `/api/tasks/${ref}`, 'lead').answer).data.task as Record<string, unknown>;
    expect(running.outcome).toBe('running');
    expect(running.id).not.toBe(ref);

    const long = `The notes are fine. ${'detail '.repeat(1200)}END`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(4000);
    reply(dev, 'Let me read them.');
    reply(dev, long, Date.now() + 5);
    dev.lastCleanOutput = long.slice(0, 4000);
    rests(dev);
    const wait = call('GET', `/api/tasks/${ref}?wait=10`, 'lead');
    const ended = (await wait.answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'completed', stopReason: 'end_turn', result: long });
    expect(liveTaskLedger()!.task(String(ended.id))).toMatchObject({ stopReason: 'end_turn', result: long });
  });

  it('(D6) an interrupted turn ends the task as stopped, interrupted, though no Stop came', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a long job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    reply(dev, 'Starting the long job.');
    const file = transcriptPath(dev.projectPath, dev.currentSessionId!, os.homedir());
    fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 10).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted', result: 'Starting the long job.' });
  });

  it('(D7) a turn that fails ends as error, with what the CLI said', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    await new Promise((r) => setTimeout(r, 30));
    rests(dev, 'error', 'Not logged in · Please run /login');
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended).toMatchObject({ outcome: 'error', stopReason: 'error' });
    expect(String(ended.error)).toContain('Not logged in');
  });

  it('(D8) a second task waits its turn, and goes in only after the first\'s answer was read', async () => {
    orchestrator();
    const dev = liveAgent('dev');
    const first = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'first job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    const second = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'second job', answer: 'started' }).answer;
    expect(second.data).toMatchObject({ queued: true, outcome: 'queued' });
    expect(String(second.data.queuedBehind)).toMatch(/from "Lead"/);
    await new Promise((r) => setTimeout(r, 600));
    expect(typed).toHaveLength(1);
    reply(dev, 'first answer');
    rests(dev);
    const one = (await call('GET', `/api/tasks/${first.data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(one).toMatchObject({ outcome: 'completed', result: 'first answer' });
    await until(() => typed.length === 2);
    expect(typed[1]).toMatchObject({ ptyId: 'pty-dev', data: 'second job', taskRef: second.data.taskId });
  });

  it('(D10) a task the terminal refuses never started, says why, and frees the queue', async () => {
    orchestrator();
    liveAgent('dev');
    writeOutcome = 'refused';
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    const ended = (await call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead').answer).data.task as Record<string, unknown>;
    expect(ended.outcome).toBe('error');
    expect(String(ended.error)).toMatch(/never started/);
    writeOutcome = 'written';
    const next = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'another', answer: 'started' }).answer;
    expect(next.data).toMatchObject({ queued: false });
  });

  it('(D11) a model asked for one task, the session already open, is said not taken', async () => {
    orchestrator();
    liveAgent('dev', { model: 'sonnet' });
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', model: 'opus', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    const task = (await call('GET', `/api/tasks/${data.taskId}`, 'lead').answer).data.task as Record<string, unknown>;
    expect(task.model).toMatchObject({ asked: 'opus', taken: false, own: 'sonnet' });
  });

  it('(D12) a CLI whose turns Tars cannot see: typed in, then said delivered, with what is not read', async () => {
    orchestrator();
    liveAgent('oc', { provider: 'opencode' });
    const { data } = await call('POST', '/api/agents/oc/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    const task = (await call('GET', `/api/tasks/${data.taskId}?wait=5`, 'lead').answer).data.task as Record<string, unknown>;
    expect(task.outcome).toBe('delivered');
    expect(String(task.error)).toMatch(/opencode/);
    expect(String(task.error)).toMatch(/cannot see when its turn ends/);
  });
});

describe('the asker following its task', () => {
  it('(D9) is not told its end in its own terminal as well', async () => {
    const lead = orchestrator();
    // At its prompt: news for it would be typed in at once.
    lead.status = 'waiting';
    lead.waitingReason = 'idle';
    const leadPty = { id: 'pty-lead', pid: 4343, write: vi.fn(), onExit: vi.fn(), onData: vi.fn() };
    (ptyProcesses as Map<string, unknown>).set('pty-lead', leadPty);
    agents.get('lead')!.ptyId = 'pty-lead';
    const dev = liveAgent('dev');
    const { data } = await call('POST', '/api/agents/dev/run-task', 'lead', { task: 'a job', answer: 'started' }).answer;
    await until(() => typed.length === 1);
    turnBegins(dev, promptOf(typed[0]));
    const wait = call('GET', `/api/tasks/${data.taskId}?wait=10`, 'lead');
    await new Promise((r) => setTimeout(r, 50));
    reply(dev, 'done');
    rests(dev);
    expect(((await wait.answer).data.task as Record<string, unknown>).result).toBe('done');
    await new Promise((r) => setTimeout(r, 300));
    expect(typed.filter((t) => t.ptyId === 'pty-lead')).toEqual([]);
  });
});
