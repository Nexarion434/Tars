import type { AgentStatus } from '../../types';
import type { RemoteAgent } from './types';

/**
 * What a paired machine is shown of this one's agents, and what this one
 * takes from another's answer (bridge `GET /machines/v1/fleet`).
 *
 * Both sides pick field by field, never a spread: a field added to an agent
 * record later stays home until it is named here. The terminal's history is
 * never in a fleet; one agent's screen and live output travel only on their
 * own routes. The reading side checks again, since the machine answering may
 * be another version of Tars, or not Tars at all.
 */

/** An agent as the bridge hands it over: the remote agent less its machine and its namespaced id. */
export type SharedAgent = Omit<RemoteAgent, 'id' | 'agentId' | 'machine'> & { id: string };

/** More than any fleet holds: what one answer may carry, on both sides. */
export const MAX_SHARED_AGENTS = 200;

/** An id that can sit in a remote id and in a URL path as it is. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MACHINE_ID = /^m-[0-9a-f]{16}$/;
// What a line of text shown in the window never needs: every control character but the line break.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value !== '' ? value.replace(CONTROL, '').slice(0, max) : undefined;

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;

/** A terminal's size, both numbers a terminal can have, or nothing. */
export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } | Record<string, never> {
  return isSize(cols) && isSize(rows) ? { cols, rows } : {};
}

/** The project's folder name, from a macOS, Linux or Windows path, a trailing separator or not. */
function folderName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** One agent's fields, from a record of this machine or an answer of another: the same picks, the same bounds. */
function pick(source: Record<string, unknown>, id: string): SharedAgent {
  const projectPath = text(source.projectPath, 400) ?? '';
  return {
    id,
    name: text(source.name, 80) ?? '',
    character: text(source.character, 40),
    provider: text(source.provider, 40),
    model: text(source.model, 80),
    status: text(source.status, 20) ?? 'unknown',
    currentTask: text(source.currentTask, 500),
    branch: text(source.branch, 120),
    projectName: text(source.projectName, 120) ?? folderName(projectPath).slice(0, 120),
    projectPath,
    cliRunning: source.cliRunning === true,
    lastActivity: text(source.lastActivity, 40),
    stoppedBy: text(source.stoppedBy, 80),
    stopReason: text(source.stopReason, 200),
    ...terminalSize(source.cols, source.rows),
  };
}

/** Drops the keys left undefined, so what travels is what was picked and set. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** One agent of this machine as a paired machine sees it, or null when its id could not travel. */
export function shareAgent(agent: AgentStatus & { cliRunning?: unknown; sessionModel?: unknown }): SharedAgent | null {
  if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || !AGENT_ID.test(agent.id)) return null;
  const source = agent as unknown as Record<string, unknown>;
  // No projectName: here it is the project folder's, never one a record carries.
  return defined(pick({
    name: source.name, character: source.character, provider: source.provider,
    model: source.sessionModel ?? source.model, status: source.status, currentTask: source.currentTask,
    branch: source.branchName, projectPath: source.projectPath, cliRunning: source.cliRunning,
    lastActivity: source.lastActivity, stoppedBy: source.stoppedBy, stopReason: source.stopReason,
    cols: source.cols, rows: source.rows,
  }, agent.id));
}

/** This machine's fleet as a paired machine sees it: the agents that can travel, one bad record losing nothing else. */
export function shareFleet(agents: Iterable<AgentStatus>): SharedAgent[] {
  const out: SharedAgent[] = [];
  for (const agent of agents) {
    if (out.length >= MAX_SHARED_AGENTS) break;
    try {
      const shared = shareAgent(agent);
      if (shared) out.push(shared);
    } catch { /* not an agent record: left out */ }
  }
  return out;
}

/** The id this machine gives another machine's agent: never one of its own fleet, which has no colon. */
export const remoteId = (machineId: string, agentId: string): string => `m:${machineId}:${agentId}`;

/** The machine and the agent a remote id names, or null for any other id. */
export function parseRemoteId(id: string): { machineId: string; agentId: string } | null {
  const m = /^m:([^:]+):([^:]+)$/.exec(id);
  return m && MACHINE_ID.test(m[1]) && AGENT_ID.test(m[2]) ? { machineId: m[1], agentId: m[2] } : null;
}

/** Another machine's agents from its fleet answer, checked as the share checks them, under that machine's ids. */
export function readFleet(body: unknown, machine: RemoteAgent['machine']): RemoteAgent[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { agents?: unknown }).agents)
    ? (body as { agents: unknown[] }).agents : [];
  const out: RemoteAgent[] = [];
  for (const item of list) {
    if (out.length >= MAX_SHARED_AGENTS) break;
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    if (typeof source.id !== 'string' || !AGENT_ID.test(source.id)) continue;
    const { id, ...fields } = defined(pick(source, source.id));
    out.push({ ...fields, id: remoteId(machine.id, id), agentId: id, machine });
  }
  return out;
}
