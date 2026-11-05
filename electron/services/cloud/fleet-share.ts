import type { AgentStatus } from '../../types';

/**
 * What a client with `see` is shown of a Tars server's agents (plan Task 6).
 * Ported from the fork's machines bridge (win/machines, fleet-share.ts, read
 * and retyped): the server's half only, a desktop's reading half comes in M2.
 *
 * Picked field by field, never a spread: a field added to the agent record
 * later stays on the server until it is named in SHARED_FIELDS. No token, no
 * environment, no CLI path, no session id, no skills, no permission mode, no
 * worktree: a client needs none of them to show an agent. The terminal's
 * history is not here either; one agent's screen travels on its own route.
 * Every string is bounded and loses its control and format characters, which
 * a desktop would otherwise render (an escape sequence, a right-to-left
 * override disguising a name).
 */

export interface SharedAgent {
  agentId: string;
  name: string;
  character?: string;
  provider?: string;
  model?: string;
  status: string;
  currentTask?: string;
  branch?: string;
  projectName: string;
  projectPath: string;
  cliRunning: boolean;
  lastActivity?: string;
  stoppedBy?: string;
  stopReason?: string;
  cols?: number;
  rows?: number;
  /** Set for its project's orchestrator only: a desktop making one there asks first, as on its own. */
  role?: 'orchestrator';
}

export const SHARED_FIELDS = [
  'agentId', 'name', 'character', 'provider', 'model', 'status', 'currentTask', 'branch',
  'projectName', 'projectPath', 'cliRunning', 'lastActivity', 'stoppedBy', 'stopReason', 'cols', 'rows', 'role',
] as const satisfies readonly (keyof SharedAgent)[];

/** More than any fleet holds. */
export const MAX_SHARED_AGENTS = 200;

/** An id that can sit in a URL path as it is. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Every control character but the line break, and every format character. */
const UNSHOWN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/gu;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value !== '' ? value.replace(UNSHOWN, '').slice(0, max) || undefined : undefined;

/** A string from the other side as a window may show it on one line: bounded, cleaned as above, its spaces folded. */
export function oneLine(value: unknown, max: number): string | undefined {
  return text(value, max)?.replace(/\s+/g, ' ').trim() || undefined;
}

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;

/** The project's folder name, from a macOS, Linux or Windows path. */
function folderName(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** One agent as a client sees it, or null when its id could not travel. */
export function shareAgent(agent: AgentStatus): SharedAgent | null {
  const source = agent as unknown as Record<string, unknown>;
  if (!agent || typeof agent !== 'object' || typeof source.id !== 'string' || !AGENT_ID.test(source.id)) return null;
  const projectPath = text(source.projectPath, 400) ?? '';
  const shared: SharedAgent = {
    agentId: source.id,
    name: text(source.name, 80) ?? '',
    character: text(source.character, 40),
    provider: text(source.provider, 40),
    model: text(source.model, 80),
    status: text(source.status, 20) ?? 'unknown',
    currentTask: text(source.currentTask, 500),
    branch: text(source.branchName, 120),
    projectName: folderName(projectPath).slice(0, 120),
    projectPath,
    cliRunning: source.cliRunning === true,
    lastActivity: text(source.lastActivity, 40),
    stoppedBy: text(source.stoppedBy, 80),
    stopReason: text(source.stopReason, 200),
    ...(isSize(source.cols) && isSize(source.rows) ? { cols: source.cols, rows: source.rows } : {}),
    ...(source.role === 'orchestrator' ? { role: 'orchestrator' as const } : {}),
  };
  return Object.fromEntries(Object.entries(shared).filter(([, v]) => v !== undefined)) as unknown as SharedAgent;
}

/** The fleet as a client sees it: the agents that can travel, one bad record losing nothing else. */
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
