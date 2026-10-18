import { hasOrchestratorPowers } from './agent-role';
import { newTaskRef } from './task-requests';
import { hasEndOfTurn } from './end-of-turn';
import { envelopeValue } from '../utils/envelope-value';
import type { AgentProvider } from '../types';

/**
 * One agent, one task at a time, and a worker never orders work from another
 * agent (2.0.4). The maintainer's two decisions of 2026-10-18, after a worker
 * delegated a gate to the QA while the orchestrator's gate of the same PR ran
 * there: Tars opened a second QA session beside the first, and both worked.
 *
 * 1. A task handed to an agent already working (a run over ACP in progress,
 *    or a turn in its terminal) never starts a second session: it waits here,
 *    first come first served, and starts once the agent is free. It has a
 *    task id from the moment it is queued, so its asker can follow it
 *    (GET /api/tasks/:id) and cancel it (POST /api/tasks/:ref/cancel). A task
 *    typed into a live terminal waits here as one sent to an agent with no
 *    session does, while a run holds the agent or tasks wait before it; a
 *    note, or Tars's own word, waits for the run's end instead, and is no
 *    task (holdsMessages). A turn in the terminal counts only where Tars can
 *    see it end (terminalTurnOf): amp, codex, grok, opencode and pi tell Tars
 *    nothing of their turns, so only their runs hold them.
 * 2. Only Tars, the user's window, an agent with an orchestrator's powers
 *    (the project's orchestrator, a chat's runner) or the agent itself hand an
 *    agent work. A worker is refused, and told to ask its orchestrator; what
 *    it sends another worker arrives as a note, once that agent's turn ends.
 *    Stopping, restarting or removing an agent is reserved to the same
 *    callers (the maintainer's decision of the same day).
 *
 * In memory: a queued task has not started, and a quit of Tars drops it as it
 * drops the request that asked for it. Whoever follows it by its id after a
 * restart is told so (unknownTaskText); keeping the queue across a restart is
 * a later change.
 */

/** What an agent is busy with: a run over ACP (queued first or not), or a turn in its terminal. */
export interface Busy {
  kind: 'run' | 'turn';
  /** The ledger's task, once the run has one. */
  taskId?: string;
  /** The queued task's id, for a run that waited its turn. */
  taskRef?: string;
  requesterId?: string;
  since: number;
  /** The task's first line, for the window's banner (2.0.4). */
  title?: string;
}

export interface QueuedTask {
  ref: string;
  agentId: string;
  requesterId?: string;
  title: string;
  queuedAt: number;
}

/**
 * Handed over in the agent's terminal once its turn came: typed into its
 * session, or a session started on it. `note`, for a CLI whose turns Tars
 * cannot see (no hook): what is not read of it (2.0.4).
 */
type Delivered = { how: 'typed' | 'started'; at: number; note?: string };

type Taken = { task: QueuedTask; taskId?: string; error?: string; delivered?: Delivered };

export interface OneTaskQueue {
  /** When this queue began, with this run of Tars: a task queued before it is gone. */
  readonly since: number;
  /** A run is on the agent from now: the check and the mark are one step for a queued task (takeTurn). */
  runStarted(agentId: string, run: Omit<Busy, 'kind'>): void;
  /** The ledger named the run's task. */
  runNamed(agentId: string, taskId: string): void;
  runEnded(agentId: string): void;
  busyRun(agentId: string): Busy | undefined;
  /** Whether a task asked now waits: the agent works, or others wait before it. */
  mustQueue(agentId: string, turn: Busy | undefined): boolean;
  enqueue(agentId: string, task: { requesterId?: string; title: string }, now?: number): QueuedTask;
  /**
   * Its turn: first in line and the agent free (no run, and `turn` undefined).
   * Taken, it leaves the line and its run is on record at once.
   */
  takeTurn(agentId: string, ref: string, turn: Busy | undefined, now?: number): boolean;
  find(ref: string): QueuedTask | undefined;
  /**
   * Where a task that waited here is, by its ref, for the caller following it:
   * still queued, taken and starting, started as the ledger's task, or ended
   * before any run started (its error).
   */
  lookup(ref: string):
    | { state: 'queued'; task: QueuedTask }
    | { state: 'starting'; task: QueuedTask }
    | { state: 'started'; task: QueuedTask; taskId: string }
    | { state: 'delivered'; task: QueuedTask; how: Delivered['how']; at: number; note?: string }
    | { state: 'failed'; task: QueuedTask; error: string }
    | undefined;
  /** The run of a task taken from the queue ended before it started: no ledger task will follow. */
  notStarted(ref: string, error: string): void;
  /**
   * A task taken from the queue went into the agent's terminal: no ledger task
   * will follow, and nothing more is waited for. `note`: what is not read of
   * a CLI whose turns Tars cannot see.
   */
  delivered(ref: string, how: Delivered['how'], note?: string, now?: number): void;
  queued(agentId: string): QueuedTask[];
  /** Out of the line, never to start: still known by its ref, as failed with `why`, to whoever follows it. */
  cancel(ref: string, why?: string): QueuedTask | undefined;
}

/** How many tasks that left the line are remembered by their ref, for a caller that follows one late. */
const STARTED_KEPT = 200;

export function createOneTaskQueue(since: number = Date.now()): OneTaskQueue {
  const runs = new Map<string, Busy>();
  const lines = new Map<string, QueuedTask[]>();
  const taken = new Map<string, Taken>();
  const lineOf = (agentId: string) => lines.get(agentId) ?? [];
  const leave = (task: QueuedTask) => {
    const line = lineOf(task.agentId).filter((t) => t.ref !== task.ref);
    if (line.length) lines.set(task.agentId, line);
    else lines.delete(task.agentId);
  };
  const find = (ref: string) => {
    for (const line of lines.values()) {
      const task = line.find((t) => t.ref === ref);
      if (task) return task;
    }
    return undefined;
  };
  const remember = (ref: string, was: Taken) => {
    taken.set(ref, was);
    while (taken.size > STARTED_KEPT) taken.delete(taken.keys().next().value as string);
  };
  return {
    since,
    runStarted(agentId, run) {
      runs.set(agentId, { kind: 'run', ...run });
    },
    runNamed(agentId, taskId) {
      const run = runs.get(agentId);
      if (!run) return;
      run.taskId = taskId;
      const was = run.taskRef ? taken.get(run.taskRef) : undefined;
      if (was) was.taskId = taskId;
    },
    runEnded(agentId) {
      runs.delete(agentId);
    },
    busyRun(agentId) {
      return runs.get(agentId);
    },
    mustQueue(agentId, turn) {
      return runs.has(agentId) || !!turn || lineOf(agentId).length > 0;
    },
    enqueue(agentId, task, now = Date.now()) {
      let ref = newTaskRef();
      while (find(ref)) ref = newTaskRef();
      const queued: QueuedTask = { ref, agentId, ...(task.requesterId ? { requesterId: task.requesterId } : {}), title: task.title, queuedAt: now };
      lines.set(agentId, [...lineOf(agentId), queued]);
      return queued;
    },
    takeTurn(agentId, ref, turn, now = Date.now()) {
      const line = lineOf(agentId);
      if (line[0]?.ref !== ref || runs.has(agentId) || turn) return false;
      const task = line[0];
      leave(task);
      remember(ref, { task });
      runs.set(agentId, { kind: 'run', taskRef: ref, ...(task.requesterId ? { requesterId: task.requesterId } : {}), since: now, title: task.title });
      return true;
    },
    find,
    lookup(ref) {
      const queued = find(ref);
      if (queued) return { state: 'queued', task: queued };
      const was = taken.get(ref);
      if (!was) return undefined;
      if (was.taskId) return { state: 'started', task: was.task, taskId: was.taskId };
      if (was.delivered) return { state: 'delivered', task: was.task, how: was.delivered.how, at: was.delivered.at, ...(was.delivered.note ? { note: was.delivered.note } : {}) };
      if (was.error !== undefined) return { state: 'failed', task: was.task, error: was.error };
      return { state: 'starting', task: was.task };
    },
    notStarted(ref, error) {
      const was = taken.get(ref);
      if (was && !was.taskId && !was.delivered) was.error = error;
    },
    delivered(ref, how, note, now = Date.now()) {
      const was = taken.get(ref);
      if (was && !was.taskId && was.error === undefined) was.delivered = { how, at: now, ...(note ? { note } : {}) };
    },
    queued(agentId) {
      return [...lineOf(agentId)];
    },
    cancel(ref, why = 'it was cancelled') {
      const task = find(ref);
      if (!task) return undefined;
      leave(task);
      remember(ref, { task, error: why });
      return task;
    },
  };
}

/** What the busy rule reads of an agent: agent-routes.ts and agent-manager.ts hand it an AgentStatus. */
export interface TurnView {
  id: string;
  provider?: AgentProvider;
  status?: string;
  waitingReason?: string;
  /** Set by the stall watch on a `running` agent that does nothing (services/stall-watch.ts). */
  stalledSince?: string;
  workHandedAt?: string;
  lastActivity?: string;
  requestedBy?: { agentId?: string };
}

/**
 * A turn in the agent's terminal, as Tars can tell one: its CLI up, and
 * working or asking (a permission, a question). `waiting` on the idle prompt
 * is Claude Code's word for a CLI at rest at its prompt: no turn.
 *
 * Only where the CLI tells Tars its turn ended (hasEndOfTurn): amp, codex,
 * grok, opencode and pi stay `running` for as long as their TUI is open, so a
 * turn read from that never ended, and every task delegated to one of them
 * waited in its queue for ever (the Audit's H1 on #449). Their terminal is
 * taken as at rest, as it was before the queue: only their runs hold them.
 * And a turn the stall watch found doing nothing for half an hour is none: a
 * claude whose Stop was lost reads `running` at its prompt.
 */
export function terminalTurnOf(agent: TurnView, cliRunning: boolean): Busy | undefined {
  if (!hasEndOfTurn(agent) || agent.stalledSince) return undefined;
  if (agent.status !== 'running' && !(agent.status === 'waiting' && agent.waitingReason !== 'idle')) return undefined;
  if (!cliRunning) return undefined;
  const since = Date.parse(agent.workHandedAt ?? agent.lastActivity ?? '') || Date.now();
  return { kind: 'turn', ...(agent.requestedBy?.agentId ? { requesterId: agent.requestedBy.agentId } : {}), since };
}

/**
 * Whether a message sent to wait for the agent's rest (pty-manager.ts,
 * WriteOrigin.untilRest) still waits: a run holds the agent, or a turn Tars
 * can see end runs in its terminal. Read by the terminals' writer, so a note,
 * or Tars's own word, never goes in beside a run, whatever the agent's status
 * reads (the Audit's M1 on #449); and never waits for an end of turn a CLI
 * without hooks never says. Never for the tasks in line: they may wait for
 * the very turn this message ends, an answer to a question (the Audit's H-A on
 * 9d9a7ad9), and a note between two tasks goes in at the rest between them.
 */
export function holdsMessages(agent: TurnView, queue: OneTaskQueue = oneTaskQueue): boolean {
  if (queue.busyRun(agent.id)) return true;
  return agent.status === 'running' && hasEndOfTurn(agent) && !agent.stalledSince;
}

/** What a queued task waits behind, said for its asker. */
export function behindText(busy: Busy, nameOf: (id: string) => string | undefined): string {
  const since = new Date(busy.since).toISOString();
  const from = busy.requesterId ? ` from ${envelopeValue(nameOf(busy.requesterId) || busy.requesterId)}` : '';
  if (busy.kind === 'turn') return `a turn in its terminal${from}, since ${since}`;
  const id = busy.taskId ?? busy.taskRef;
  return `${id ? `task ${id}` : 'a run'}${from}, since ${since}`;
}

/** The caller as the drive routes resolve it (agent-routes.ts, resolveDriver). */
export type WorkCaller = { kind: 'tars' } | { kind: 'agent'; agent: { id: string; name?: string; role?: string; kind?: string } };

/** Who hands `target` work, and stops it: Tars, an agent with an orchestrator's powers, or the agent itself. */
function leads(caller: WorkCaller, target: { id: string }): boolean {
  return caller.kind === 'tars' || caller.agent.id === target.id || hasOrchestratorPowers(caller.agent);
}

/**
 * Null when this caller may hand `target` work: Tars, an agent with an
 * orchestrator's powers, or the agent itself. Else the refusal a worker reads.
 */
export function workerOrderRefusal(caller: WorkCaller, target: { id: string; name?: string }): string | null {
  if (leads(caller, target)) return null;
  const name = envelopeValue(target.name || target.id);
  return `A worker does not hand work to another agent: only Tars, the user's window and your project's orchestrator start ${name} `
    + `or give it a task. Ask your orchestrator for it (send_message to "orchestrator"), or send ${name} a note for information `
    + `with send_message: it reads it once its turn has ended, and it is not a task.`;
}

/**
 * Null when this caller may stop, restart or remove `target` (its CLI ended,
 * started again, or the agent deleted): the callers that hand it work. Else
 * the refusal a worker reads.
 */
export function workerStopRefusal(caller: WorkCaller, target: { id: string; name?: string }): string | null {
  if (leads(caller, target)) return null;
  const name = envelopeValue(target.name || target.id);
  return `A worker does not stop, restart or remove another agent: only Tars, the user's window and your project's orchestrator do. `
    + `Ask your orchestrator to stop ${name} (send_message to "orchestrator"), and say why.`;
}

/**
 * What a follower of a task id this run of Tars does not know is told. A task
 * still waiting its turn when Tars quit was in this queue's memory only: gone,
 * and never started.
 */
export function unknownTaskText(since: number): string {
  return `No such task. This Tars started at ${new Date(since).toISOString()} and keeps no task that was still waiting its turn `
    + 'before a restart: such a task never started, and must be asked again.';
}

/**
 * A worker writing to whoever leads it is reporting, not ordering: its
 * requester, or an agent with an orchestrator's powers in its project (as
 * requestFor in agent-routes.ts reads it).
 */
export function isReportTo(
  caller: { id: string; projectPath?: string; requestedBy?: { agentId?: string } },
  target: { id: string; role?: string; kind?: string; projectPath?: string },
): boolean {
  return caller.requestedBy?.agentId === target.id || (hasOrchestratorPowers(target) && target.projectPath === caller.projectPath);
}

/** A worker's message to another agent, as it is typed in: a note, labelled so, never an order. */
export function noteFrom(senderName: string, message: string): string {
  return `[Note for information from ${envelopeValue(senderName)}, a worker: it is not a task, and asks nothing of you unless your own work needs it.] ${message}`;
}

/** The fleet's queue: one for the process, read by the drive routes and the task routes. */
export const oneTaskQueue = createOneTaskQueue();
