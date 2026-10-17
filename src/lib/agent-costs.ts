import type { TaskEntry } from '@/types/electron';
import { filterTasks, providerText, tokensTotal } from '@/lib/task-costs';
import type { TaskFilter } from '@/lib/task-costs';
import { flat } from '@/lib/stop-line';

/**
 * What the Usage page says of each agent: the tasks of the timeframe and the
 * project picked, one row per agent, beside the view by task (JeanBrasse, 13/10).
 * Frame: `Usage · cost per agent`, and its light copy. Its failures are
 * listed, and pinned, in __tests__/lib/agent-costs.test.ts.
 *
 * A row adds up the agent's tasks, which hold every turn of its sessions since
 * Tars records tasks (1.9.3): measured on four agents on 13/10, their tasks
 * held every reply of their transcripts since the ledger's first task.
 */

export type UsageView = 'task' | 'agent';

/** Where the page remembers the view last picked: a convenience of this window's, nothing more. */
export const USAGE_VIEW_KEY = 'tars-usage-view';

/** The view a stored value names; by task for anything else, nothing included. */
export function usageViewOf(stored: string | null | undefined): UsageView {
  return stored === 'agent' ? 'agent' : 'task';
}

/** The agent view keeps the project picked; the agent picked stays the task view's. */
export function agentViewFilter(filter: TaskFilter): TaskFilter {
  return { projectPath: filter.projectPath, agentId: null };
}

/** What the switch counts: the tasks the task view lists, the agents the agent view does. */
export function viewCounts(tasks: TaskEntry[], filter: TaskFilter): { tasks: number; agents: number } {
  return {
    tasks: filterTasks(tasks, filter).length,
    agents: new Set(filterTasks(tasks, agentViewFilter(filter)).map(t => t.agentId)).size,
  };
}

/** A project by its folder's name, from a POSIX or a Windows path, on one line; `-` without one. */
export function projectName(projectPath: string | null): string {
  if (!projectPath) return '-';
  return flat(projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath);
}

export interface AgentTotal {
  agentId: string;
  tasks: number;
  /** Of those, the ones whose cost is known. */
  counted: number;
  /** Of those, the ones still running. */
  running: number;
  /** The counted tasks' own costs added up, never their totals; null when none is counted. */
  costUSD: number | null;
  /** A task of it is not counted, or counted only in part: what it spent is more than the sum. */
  partial: boolean;
  /** Every token of the counted tasks, the cache's included; null when none counted any. */
  tokens: number | null;
  /** The ended tasks' time added up; null when none has ended. */
  durationMs: number | null;
  /** The project of its latest task that names one. */
  projectPath: string | null;
  /** The providers its tasks ran on, with their Claude accounts, the latest first, each once. */
  providers: string[];
}

/**
 * One row per agent, by its id: the dearest first, then the one with the most
 * tasks, then by id; an agent with nothing counted last.
 */
export function totalsByAgent(tasks: TaskEntry[], accountLabels: Record<string, string>): AgentTotal[] {
  const latestFirst = [...tasks].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const rows = new Map<string, AgentTotal>();
  for (const t of latestFirst) {
    let row = rows.get(t.agentId);
    if (!row) {
      row = {
        agentId: t.agentId, tasks: 0, counted: 0, running: 0, costUSD: null, partial: false,
        tokens: null, durationMs: null, projectPath: null, providers: [],
      };
      rows.set(t.agentId, row);
    }
    row.tasks += 1;
    if (t.endedAt === null) row.running += 1;
    if (t.costUSD !== null) {
      row.counted += 1;
      row.costUSD = (row.costUSD ?? 0) + t.costUSD;
    }
    if (t.costUSD === null || t.partial) row.partial = true;
    const tokens = tokensTotal(t);
    if (tokens !== null) row.tokens = (row.tokens ?? 0) + tokens;
    if (t.durationMs !== null) row.durationMs = (row.durationMs ?? 0) + t.durationMs;
    if (row.projectPath === null && t.projectPath) row.projectPath = t.projectPath;
    const provider = providerText(t, accountLabels);
    if (!row.providers.includes(provider)) row.providers.push(provider);
  }
  return [...rows.values()]
    .map(row => (row.counted === 0 ? { ...row, partial: false } : row))
    .sort((a, b) => (b.costUSD ?? -1) - (a.costUSD ?? -1)
      || b.tasks - a.tasks
      || a.agentId.localeCompare(b.agentId));
}

/** The columns of the agent view a header sorts by: every one but the agent's own name (JeanBrasse, 18/10). */
export type AgentSortKey = 'project' | 'provider' | 'tasks' | 'time' | 'tokens' | 'cost';

export interface AgentSort {
  key: AgentSortKey;
  /** Highest first, the first click; lowest first, the second. */
  direction: 'descending' | 'ascending';
}

/** The sort a click on a header gives: highest first, then lowest first, then none, the default order back. Another header starts at highest first. */
export function nextAgentSort(current: AgentSort | null, key: AgentSortKey): AgentSort | null {
  if (!current || current.key !== key) return { key, direction: 'descending' };
  return current.direction === 'descending' ? { key, direction: 'ascending' } : null;
}

/** A row's value in a column: what the row shows, compared as what it is. Null for a row without one. */
function sortValue(row: AgentTotal, key: AgentSortKey): number | string | null {
  switch (key) {
    case 'project': return row.projectPath ? projectName(row.projectPath) : null;
    case 'provider': return row.providers[0] ?? null;
    case 'tasks': return row.tasks;
    case 'time': return row.durationMs;
    case 'tokens': return row.tokens;
    case 'cost': return row.costUSD;
  }
}

/**
 * The rows in a column's order, as a new array: highest first or lowest
 * first, a row without the value last either way, rows of equal value in the
 * order given, which is the default one. Figures by their values, words by
 * their letters whatever their case.
 */
export function sortAgentRows(rows: AgentTotal[], sort: AgentSort | null): AgentTotal[] {
  if (!sort) return [...rows];
  const sign = sort.direction === 'descending' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    const order = typeof x === 'number' && typeof y === 'number'
      ? x - y
      : String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true });
    return sign * order;
  });
}
