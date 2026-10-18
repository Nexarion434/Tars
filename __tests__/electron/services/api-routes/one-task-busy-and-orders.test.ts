import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * One task at a time and a worker's orders, at the routes, after the Audit's
 * gate of #449 at f9966e6e: what a run, a turn and a note really hold, for
 * every CLI, and the routes the first pass missed. The routes, the queue, the
 * terminals' writer and the kanban's claim are the real ones; the terminals
 * are fake ptys, and a run over ACP lasts until the test ends it.
 *
 * How it fails, written before the code (2026-10-18):
 * 1. (H1) An agent whose CLI tells Tars nothing of its turns (amp, codex,
 *    grok, opencode, pi: no end-of-turn hook) reads busy for ever once its
 *    terminal was handed a task: it stays `running` while its TUI is open,
 *    and every task delegated to it waits in its queue for ever.
 * 2. (H1) A claude agent whose Stop hook was lost, which the stall watch
 *    found doing nothing (stalledSince), holds its line for ever the same way.
 * 3. (H1) The other way round: a claude agent in a turn Tars can see end no
 *    longer holds its line, and a delegated run starts beside the turn.
 * 4. (H1) A worker's note to an agent with no end-of-turn hook waits for a
 *    turn's end that never comes: it is never typed in.
 * 5. (M1) A task typed into a live terminal never asks the queue: start_agent
 *    (/dispatch with a task) types into an agent at its prompt while a
 *    delegated run of it works, and two copies of it work at once; or, once
 *    it waited its turn, it never goes in.
 * 6. (M1) The same through /message.
 * 7. (M1) At the end of a terminal turn, a note held for it and a run queued
 *    behind the same turn both go: one into the terminal, one over ACP; or,
 *    the run under way, the note goes in as soon as the agent's status reads
 *    idle (its terminal's Stop came late, or the run does not own the status).
 * 8. (M1) Tars's own note (the kanban's, the error triage's) is typed into a
 *    terminal while a run of its agent works, or is queued as a task.
 * 9. (M2) A worker hands another agent a kanban task (assign_task with
 *    agent_id), which types it into that agent or starts it: an order; or the
 *    orchestrator is refused the same.
 * 10. (L1) A worker's steer, /run-task or /start reaches another agent.
 * 11. (L1) A worker's note to an agent with no session starts one, through
 *     /dispatch or /message.
 * 12. (L1) A stranger reads a task queued for another agent, or the shared
 *     token cancels one.
 * 13. (L2) A queued task is cancelled by a chat's runner that did not ask for
 *     it, or by the project's orchestrator with no reason, and the chat that
 *     asked is not told; or its asker, or Tars, is refused.
 * 14. (L3) A task given with start_agent that waited its turn is said
 *     `starting` for ever once it was handed over: its follower cannot tell it
 *     went in.
 */

type FakePty = { pid: number; process: string; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> };
const spawned = vi.hoisted(() => [] as FakePty[]);
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string): FakePty => {
    const t: FakePty = { pid: 7000 + spawned.length, process: file, write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    spawned.push(t);
    return t;
  }),
}));
let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-spawned-${++uuidCounter}`) }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({ needsPromptInjection: () => false, assembleDigest: async () => '', wrapDigestForPrompt: (d: string) => d }));
const runs = vi.hoisted(() => [] as { task: string; end: () => void }[]);
vi.mock('../../../../electron/services/acp/delegate', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/acp/delegate')>()),
  canDelegateOverAcp: () => true,
  delegateOverAcp: async (opts: { task: string; onStarted?: (r: object) => void }) => {
    opts.onStarted?.({});
    await new Promise<void>((resolve) => runs.push({ task: opts.task, end: resolve }));
    return { ok: true, transport: 'acp', started: true, stopReason: 'end_turn', text: 'done', toolCalls: [] };
  },
}));
// Who was told a task they asked for was cancelled: the chat that asked.
const told = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../../electron/services/agent-watch', async (original) => ({
  ...(await original<typeof import('../../../../electron/services/agent-watch')>()),
  tellCancelled: (...args: unknown[]) => { told.push(args); },
}));

import { registerAgentRoutes, performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { registerTaskRoutes } from '../../../../electron/services/api-routes/task-routes';
import { registerKanbanRoutes } from '../../../../electron/services/api-routes/kanban-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agents, wireDialogProbe } from '../../../../electron/core/agent-manager';
import { ptyProcesses, resetTerminalInput } from '../../../../electron/core/pty-manager';
import { spawnAgentPty } from '../../../../electron/core/agent-pty';
import { oneTaskQueue } from '../../../../electron/core/one-task';
import { setLiveTaskLedger, type TaskLedger } from '../../../../electron/services/task-ledger';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'one-task-busy-'));
let routes: RouteApp & { routes: Array<{ method: string; pattern: string | RegExp; handler: (req: RouteRequest, send: (data: unknown, status?: number) => void, ctx: RouteContext) => unknown }> };
let ctx: RouteContext;
const tasks = new Map<string, Record<string, unknown>>();
const used = new Set<string>();

type Answer = { data: Record<string, unknown>; status: number };

/** A route called as the agent `caller` presents its own token (or Tars's pass, or the shared token: no caller). */
function call(method: string, url: string, body: Record<string, unknown>, caller: string | undefined, opts: { internal?: boolean } = {}) {
  const pathname = url.split('?')[0];
  const route = routes.routes.find(r => r.method === method && (typeof r.pattern === 'string' ? r.pattern === pathname : r.pattern.test(pathname)))!;
  const m = typeof route.pattern === 'string' ? [pathname] : pathname.match(route.pattern)!;
  let got: Answer | undefined;
  const req = {
    method, pathname, url: new URL(`http://localhost${url}`), body, raw: { headers: {}, on: () => {} }, res: {},
    params: m[1] ? { id: m[1] } : {}, callerAgentId: caller, ...(opts.internal ? { internal: true } : {}),
  } as unknown as RouteRequest;
  const done = route.handler(req, (data, status = 200) => { if (!got) got = { data: data as Record<string, unknown>, status }; }, ctx);
  return { done: Promise.resolve(done), answer: () => got };
}

function member(id: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  used.add(id);
  const agent = {
    id, name: id.toUpperCase(), role: 'worker', status: 'idle', projectPath: project, provider: 'claude', skills: [], output: [],
    lastActivity: new Date().toISOString(), permissionMode: 'bypass', ...extra,
  } as AgentStatus;
  agents.set(id, agent);
  return agent;
}

/** An agent whose terminal runs its CLI (the foreground process is what cliRunningIn reads). */
function withCli(id: string, provider: string, status: AgentStatus['status'], extra: Partial<AgentStatus> = {}) {
  const terminal = spawnAgentPty({ binaryName: provider === 'claude' ? 'claude' : provider, shell: '/bin/bash', args: ['-l'], runsCommand: false, cwd: project, cols: 120, rows: 30, env: { CLAUDE_AGENT_ID: id } }) as unknown as FakePty;
  terminal.process = provider === 'claude' ? '2.1.300' : provider;
  ptyProcesses.set(`pty-${id}`, terminal as never);
  const agent = member(id, { status, provider: provider as AgentStatus['provider'], ptyId: `pty-${id}`, ptyCwd: project, currentSessionId: `sess-${id}`, ...extra });
  return { agent, terminal };
}
const typedInto = (t: FakePty) => t.write.mock.calls.map(c => String(c[0])).join('');
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  resetLaunches(); vi.useFakeTimers(); agents.clear(); ptyProcesses.clear(); spawned.length = 0; runs.length = 0; tasks.clear(); told.length = 0; used.clear();
  setLiveTaskLedger({
    acpStarted: ({ agent, requesterAgentId }: { agent: AgentStatus; requesterAgentId?: string }) => { const id = `task-${tasks.size + 1}`; tasks.set(id, { id, agentId: agent.id, requesterAgentId, source: 'acp', outcome: 'running', startedAt: Date.now() }); return id; },
    acpEnded: (id: string, end: { outcome: string }) => { tasks.set(id, { ...tasks.get(id)!, outcome: end.outcome, endedAt: Date.now() }); },
    task: (id: string) => tasks.get(id),
  } as unknown as TaskLedger);
  routes = { routes: [], add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); }, get(p, h) { this.add('GET', p, h); }, post(p, h) { this.add('POST', p, h); }, put(p, h) { this.add('PUT', p, h); }, delete(p, h) { this.add('DELETE', p, h); } } as typeof routes;
  const settings = {} as AppSettings;
  ctx = { mainWindow: null, appSettings: settings, getAppSettings: () => settings, getTelegramBot: () => null, getSlackApp: () => null, slackResponseChannel: null, slackResponseThreadTs: null, handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(), initAgentPtyCallback: vi.fn(async () => 'unused'), agentStatusEmitter: new EventEmitter() } as RouteContext;
  registerAgentRoutes(routes, ctx);
  registerTaskRoutes(routes);
  registerKanbanRoutes(routes, ctx);
  // What main.ts wires at launch: a message sent to wait for a turn's end reads the agents.
  wireDialogProbe();
  member('orch', { role: 'orchestrator', status: 'running' });
  // Two chats' runners: stored as workers, with an orchestrator's powers, each for its own chat.
  member('chat2', { role: 'worker', kind: 'chat', status: 'running' } as Partial<AgentStatus>);
  member('chat3', { role: 'worker', kind: 'chat', status: 'running' } as Partial<AgentStatus>);
});

afterEach(() => {
  for (const r of runs) r.end();
  for (const id of used) {
    for (const t of oneTaskQueue.queued(id)) oneTaskQueue.cancel(t.ref);
    oneTaskQueue.runEnded(id);
  }
  for (const t of spawned) resetTerminalInput(t as never);
  vi.useRealTimers();
  setLiveTaskLedger(null);
});

describe('what holds an agent, for every CLI (H1)', () => {
  it('1. a codex worker whose terminal took a task, its TUI open and running, still gets a delegated task: the run starts', async () => {
    withCli('cx', 'codex', 'running');
    const a = call('POST', '/api/agents/cx/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    expect(a.answer()?.data, JSON.stringify(a.answer())).toMatchObject({ started: true });
    expect(a.answer()?.data.queued).toBeUndefined();
    expect(runs.map(r => r.task).join('\n')).toContain('TASK-A');
  });

  it('2. a claude worker the stall watch found doing nothing (its Stop lost) does not hold its line', async () => {
    withCli('st', 'claude', 'running', { stalledSince: new Date(Date.now() - 31 * 60_000).toISOString() } as Partial<AgentStatus>);
    const a = call('POST', '/api/agents/st/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    expect(a.answer()?.data, JSON.stringify(a.answer())).toMatchObject({ started: true });
    expect(runs).toHaveLength(1);
  });

  it('3. a claude worker in a turn Tars can see end still holds its line: the run waits for the turn', async () => {
    const { agent } = withCli('cl', 'claude', 'running');
    const a = call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    expect(a.answer()?.data).toMatchObject({ queued: true, outcome: 'queued' });
    expect(String(a.answer()?.data.queuedBehind)).toContain('a turn in its terminal');
    expect(runs).toHaveLength(0);
    agent.status = 'idle';
    await later(1500);
    expect(runs, 'started once the turn ended').toHaveLength(1);
  });

  it('4. a worker\'s note to a codex worker, its TUI open, is typed in: no turn end is waited for that never comes', async () => {
    const { terminal } = withCli('cx', 'codex', 'running');
    member('w1');
    const n = call('POST', '/api/agents/cx/dispatch', { message: 'NOTE-ONE the notes are in' }, 'w1');
    await later(3000);
    await n.done;
    expect(n.answer()?.data, JSON.stringify(n.answer())).toMatchObject({ success: true, note: true });
    expect(typedInto(terminal)).toContain('NOTE-ONE');
  });
});

describe('nothing goes into a terminal beside a run (M1)', () => {
  it('5. start_agent to an agent at its prompt while its delegated run works is queued, then typed in once the run ends, and said so', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    expect(runs).toHaveLength(1);
    const b = call('POST', '/api/agents/cl/dispatch', { message: 'TASK-B fix it', intent: 'task' }, 'orch');
    await later(2000);
    await b.done;
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ success: true, mode: 'queued', queued: true });
    const ref = String(b.answer()?.data.queuedTask);
    expect(ref).toMatch(/^t-[0-9a-f]{8}$/);
    expect(typedInto(terminal), 'typed beside the run').not.toContain('TASK-B');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('TASK-B');
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ id: ref, outcome: 'delivered', how: 'typed' });
  });

  it('6. /message to an agent at its prompt while its delegated run works types nothing, and says to send it with /dispatch', async () => {
    const { terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    const c = call('POST', '/api/agents/cl/message', { message: 'TASK-C fix it' }, 'orch');
    await later(2000);
    await c.done;
    expect(c.answer(), JSON.stringify(c.answer())).toMatchObject({ status: 409, data: { code: 'agent_busy' } });
    expect(typedInto(terminal)).not.toContain('TASK-C');
  });

  it('7. a note held for a turn\'s end waits for the run queued behind that turn, whatever the status reads, and goes in once the run ends', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'running');
    member('w1');
    const a = call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    expect(a.answer()?.data).toMatchObject({ outcome: 'queued' });
    const n = call('POST', '/api/agents/cl/dispatch', { message: 'NOTE-TWO read me later' }, 'w1');
    await later(1500);
    await n.done;
    expect(n.answer()?.data).toMatchObject({ success: true, note: true, queued: true });
    expect(typedInto(terminal)).not.toContain('NOTE-TWO');
    // Its Stop: the turn ends.
    agent.status = 'idle';
    await later(3000);
    expect(runs, 'the run queued behind the turn took it').toHaveLength(1);
    expect(typedInto(terminal), 'the note went in beside the run').not.toContain('NOTE-TWO');
    // The terminal's own status reads idle while the run works (its Stop came late, or the run does not own the
    // status): the run still holds the agent.
    agent.status = 'idle';
    await later(3000);
    expect(typedInto(terminal), 'the note went in beside the run, the status reading idle').not.toContain('NOTE-TWO');
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('NOTE-TWO');
  });

  it('8. Tars\'s own note to an agent whose run works waits for the run, and is no task in its queue', async () => {
    const { agent, terminal } = withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    let got: Answer | undefined;
    const written = vi.fn();
    await performDispatch(agent, {
      message: 'INFO-ONE a task landed on your board', from: 'Tars', sender: { kind: 'tars' }, information: true, onWritten: written,
    } as Parameters<typeof performDispatch>[1], ctx, (data, status = 200) => { got ??= { data: data as Record<string, unknown>, status }; });
    await later(1500);
    expect(got?.data, JSON.stringify(got)).toMatchObject({ success: true, mode: 'message' });
    expect(got?.data.queuedTask).toBeUndefined();
    expect(oneTaskQueue.queued('cl')).toEqual([]);
    expect(typedInto(terminal)).not.toContain('INFO-ONE');
    expect(written).not.toHaveBeenCalled();
    runs[0].end();
    await later(3000);
    expect(typedInto(terminal)).toContain('INFO-ONE');
    expect(written).toHaveBeenCalled();
  });
});

describe('a worker hands no work through the kanban (M2)', () => {
  it('9. a worker\'s assign_task for another agent is refused, and says to ask its orchestrator; the orchestrator\'s is not', async () => {
    member('w1');
    member('w2');
    const byWorker = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w2' }, 'w1');
    await byWorker.done;
    expect(byWorker.answer(), JSON.stringify(byWorker.answer())).toMatchObject({ status: 403, data: { code: 'worker_may_not_order' } });
    expect(String(byWorker.answer()?.data.error)).toContain('Ask your orchestrator');
    // Past the role: the board answers (here, no Hermes is configured).
    const byLead = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w2' }, 'orch');
    await byLead.done;
    expect(byLead.answer()?.status, JSON.stringify(byLead.answer())).not.toBe(403);
    const forItself = call('POST', '/api/kanban/tasks/t_0123abcd/claim', { agent_id: 'w1' }, 'w1');
    await forItself.done;
    expect(forItself.answer()?.status).not.toBe(403);
    expect(spawned).toHaveLength(0);
  });
});

describe('the routes the mutants walked through (L1)', () => {
  it('10. a worker\'s steer, run-task and start of another agent are refused, and nothing starts', async () => {
    member('w1');
    withCli('cl', 'claude', 'running');
    member('w3');
    const steer = call('POST', '/api/agents/cl/dispatch', { message: 'stop that', mode: 'steer' }, 'w1');
    const run = call('POST', '/api/agents/cl/run-task', { task: 'TASK-W run the gate', answer: 'started' }, 'w1');
    const start = call('POST', '/api/agents/w3/start', { prompt: 'TASK-W run the gate' }, 'w1');
    await later(500);
    await Promise.all([steer.done, run.done, start.done]);
    for (const [what, a] of [['steer', steer], ['run-task', run], ['start', start]] as const) {
      expect(a.answer(), `${what}: ${JSON.stringify(a.answer())}`).toMatchObject({ status: 403, data: { code: 'worker_may_not_order' } });
    }
    expect(runs).toHaveLength(0);
    expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
  });

  it('11. a worker\'s note to an agent with no session starts none, through /dispatch or /message', async () => {
    member('w1');
    member('w2');
    const d = call('POST', '/api/agents/w2/dispatch', { message: 'NOTE-THREE' }, 'w1');
    const m = call('POST', '/api/agents/w2/message', { message: 'NOTE-FOUR' }, 'w1');
    await later(500);
    await Promise.all([d.done, m.done]);
    expect(d.answer(), JSON.stringify(d.answer())).toMatchObject({ status: 409, data: { code: 'note_needs_session' } });
    expect(m.answer(), JSON.stringify(m.answer())).toMatchObject({ status: 409, data: { code: 'note_needs_session' } });
    expect(ctx.initAgentPtyCallback).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it('12. a stranger cannot read a queued task, and the shared token cannot cancel one', async () => {
    withCli('cl', 'claude', 'idle');
    member('w2');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    const b = call('POST', '/api/agents/cl/run-task', { task: 'TASK-B fix it', answer: 'started' }, 'orch');
    await later(50);
    const ref = String(b.answer()?.data.taskId);
    expect(b.answer()?.data).toMatchObject({ outcome: 'queued' });
    const stranger = call('GET', `/api/tasks/${ref}`, {}, 'w2');
    const asker = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await Promise.all([stranger.done, asker.done]);
    expect(stranger.answer()?.status, JSON.stringify(stranger.answer())).toBe(404);
    expect(asker.answer()?.data.task).toMatchObject({ id: ref, outcome: 'queued' });
    const shared = call('POST', `/api/tasks/${ref}/cancel`, {}, undefined);
    await shared.done;
    expect(shared.answer()?.status).toBe(404);
    expect(oneTaskQueue.find(ref), 'still queued').toBeDefined();
  });
});

describe('who takes a queued task back (L2)', () => {
  it('13. its asker, Tars, or the project\'s orchestrator with a reason, which the chat that asked is told; not another chat', async () => {
    withCli('cl', 'claude', 'idle');
    call('POST', '/api/agents/cl/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    const queue = async (by: string, task: string) => {
      const q = call('POST', '/api/agents/cl/run-task', { task, answer: 'started' }, by);
      await later(50);
      expect(q.answer()?.data, JSON.stringify(q.answer())).toMatchObject({ outcome: 'queued' });
      return String(q.answer()?.data.taskId);
    };
    const cancel = async (ref: string, by: string | undefined, body: Record<string, unknown> = {}, internal = false) => {
      const c = call('POST', `/api/tasks/${ref}/cancel`, body, by, { internal });
      await c.done;
      return c.answer()!;
    };
    const b = await queue('chat2', 'TASK-B of chat 2');
    const otherChat = await cancel(b, 'chat3', { reason: 'mine now' });
    expect(otherChat, JSON.stringify(otherChat)).toMatchObject({ status: 403, data: { error: 'not_your_task' } });
    expect(oneTaskQueue.find(b), 'still queued').toBeDefined();
    const noReason = await cancel(b, 'orch');
    expect(noReason, JSON.stringify(noReason)).toMatchObject({ status: 400, data: { error: 'reason_required' } });
    expect(oneTaskQueue.find(b), 'still queued').toBeDefined();
    const withReason = await cancel(b, 'orch', { reason: 'the gate moved' });
    expect(withReason, JSON.stringify(withReason)).toMatchObject({ status: 200, data: { success: true, cancelled: b } });
    expect(oneTaskQueue.find(b)).toBeUndefined();
    expect(told, 'the chat that asked is told').toEqual([['chat2', 'cl', expect.any(String), 'the gate moved']]);
    const c = await queue('chat2', 'TASK-C of chat 2');
    expect(await cancel(c, 'chat2'), 'its asker, with no reason').toMatchObject({ status: 200, data: { cancelled: c } });
    const d = await queue('orch', 'TASK-D of the lead');
    expect(await cancel(d, undefined, {}, true), "Tars's own pass").toMatchObject({ status: 200, data: { cancelled: d } });
    expect(told).toHaveLength(1);
  });
});

describe('a task that waited its turn and went in (L3)', () => {
  it('14. start_agent queued behind a run is said delivered once its session started, never starting for ever', async () => {
    member('w3');
    call('POST', '/api/agents/w3/run-task', { task: 'TASK-A review', answer: 'started' }, 'orch');
    await later(50);
    const b = call('POST', '/api/agents/w3/dispatch', { message: 'TASK-B fix it', intent: 'task' }, 'orch');
    await later(50);
    await b.done;
    expect(b.answer()?.data, JSON.stringify(b.answer())).toMatchObject({ mode: 'queued' });
    const ref = String(b.answer()?.data.queuedTask);
    runs[0].end();
    await later(5000);
    const seen = call('GET', `/api/tasks/${ref}`, {}, 'orch');
    await seen.done;
    expect(seen.answer()?.data.task, JSON.stringify(seen.answer())).toMatchObject({ id: ref, outcome: 'delivered', how: 'started' });
  });
});
