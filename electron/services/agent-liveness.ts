import { AgentStatus } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { emitAgentStatus } from './agent-events';

/**
 * Whether an agent is really working, as opposed to still labelled as if it
 * were.
 *
 * The status lifecycle belongs to the hook scripts: user-prompt-submit.sh
 * posts `running`, on-stop.sh posts `idle`. They are separate processes
 * talking to the app over HTTP, and when one of those posts is lost - the
 * curl times out, the port refuses for a moment, the process is killed
 * between the two calls - nothing posts it again. The record keeps the last
 * thing it was told, which is `running`, and no later event ever contradicts
 * it. That is the agent sitting at `running` with a thousand seconds of
 * silence behind it, and an orchestrator waiting on a task that finished
 * long ago.
 *
 * The hooks are made more stubborn separately (hooks/lib.sh retries). This is
 * the other half: something that reads the status back against what the
 * process is actually doing, so a lost post is corrected rather than
 * believed forever.
 */

/**
 * Agents with an Agent Client Protocol turn in flight.
 *
 * An ACP delegation runs beside the terminal rather than in it, so it emits
 * no PTY output at all and looks exactly like an abandoned session to every
 * test below. It is the one case where a silent `running` is the truth.
 */
const acpTurns = new Set<string>();

export function beginAcpTurn(agentId: string): void {
  acpTurns.add(agentId);
}

export function endAcpTurn(agentId: string): void {
  acpTurns.delete(agentId);
}

export function hasAcpTurn(agentId: string): boolean {
  return acpTurns.has(agentId);
}

/**
 * How long `running` may go without a single byte from the PTY before it is
 * read as a leftover.
 *
 * Every chunk the terminal emits stamps `lastActivity`, and a CLI that is
 * working is never quiet: it redraws its spinner, its token count, its tool
 * output. Ten minutes of complete silence is not a slow task, it is a
 * process that has finished or died with nobody left to say so. Generous on
 * purpose - the cost of being wrong here is unblocking a waiting caller a
 * few minutes early, and the cost of being timid is the ghost staying all
 * day.
 */
export const GHOST_AFTER_MS = 10 * 60 * 1000;

export interface LivenessInputs {
  /** Whether this agent's PTY is still in the live map. */
  ptyAlive: boolean;
  /** Whether an ACP turn is running for it right now. */
  acpInFlight: boolean;
  now?: number;
}

/**
 * Correct `agent.status` if it claims work that nothing is doing. Returns
 * true when it changed something.
 *
 * Only `running` is ever touched. `waiting` is a real, legitimately motionless
 * state - an agent parked at a confirmation or a permission dialog produces no
 * output for as long as nobody answers it, and it is already terminal for
 * /wait - so reconciling it would break the thing it is meant to protect.
 *
 * `idle` is the correction, not `error` or `completed`: nothing here knows
 * whether the task succeeded, only that it is no longer running. It is also
 * exactly what on-stop.sh would have posted had its curl arrived.
 */
export function reconcileAgentStatus(agent: AgentStatus, inputs: LivenessInputs): boolean {
  if (agent.status !== 'running') return false;
  if (inputs.acpInFlight) return false;

  // A session whose PTY is gone is finished, whatever the record says, and
  // there is nothing left that could ever post its status. No grace period is
  // owed to a process that does not exist.
  const ptyGone = !!agent.ptyId && !inputs.ptyAlive;

  const now = inputs.now ?? Date.now();
  const lastActivityMs = Date.parse(agent.lastActivity || '') || 0;
  const silent = lastActivityMs > 0 && now - lastActivityMs >= GHOST_AFTER_MS;

  if (!ptyGone && !silent) return false;

  agent.status = 'idle';
  agent.waitingReason = undefined;
  return true;
}

/** The same check for an agent held in the live maps, with the inputs read
 *  for you. Used on every route that reports a status. */
export function reconcileFromRuntime(agent: AgentStatus, now?: number): boolean {
  return reconcileAgentStatus(agent, {
    ptyAlive: !!(agent.ptyId && ptyProcesses.has(agent.ptyId)),
    acpInFlight: hasAcpTurn(agent.id),
    now,
  });
}

/**
 * How often the whole fleet is checked.
 *
 * Reading a status corrects that one agent, which covers everything an
 * orchestrator asks about. The sweep is for the rest: an agent nobody is
 * currently polling still has to stop showing a task it is not doing, and
 * the dashboard has to stop drawing it as busy. A minute is far below the
 * ten-minute threshold it enforces and costs a map walk.
 */
const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: NodeJS.Timeout | null = null;

/** One pass over the fleet. Exported for the tests; the timer calls it. */
export function sweepAgentLiveness(now?: number): string[] {
  const corrected: string[] = [];
  for (const agent of agents.values()) {
    if (reconcileFromRuntime(agent, now)) {
      corrected.push(agent.id);
    }
  }
  if (corrected.length > 0) {
    saveAgents();
    for (const id of corrected) emitAgentStatus(id);
    console.log(`[liveness] reconciled ${corrected.length} ghost status(es): ${corrected.join(', ')}`);
  }
  return corrected;
}

export function startAgentLivenessSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepAgentLiveness(), SWEEP_INTERVAL_MS);
  // Never hold the process open for a housekeeping pass.
  sweepTimer.unref?.();
}

export function stopAgentLivenessSweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
