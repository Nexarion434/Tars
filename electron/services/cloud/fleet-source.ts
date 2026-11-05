import type { AgentStatus } from '../../types';
import { shareFleet, type SharedAgent } from './fleet-share';
import type { CloudClient, Scope } from './types';

/** A cloud project as a client sees it: a folder on the server that holds agents. */
export interface CloudProject { name: string; path: string }

export interface FleetAnswer {
  v: 1;
  server: { id: string; name: string };
  /** What this client may do: it shapes the client's window, the server decides. */
  youMay: Scope[];
  projects: CloudProject[];
  agents: SharedAgent[];
}

/** What an agent's terminal says now: never stored on the record, read at each answer (as agent:get does). */
export interface AgentLive { cliRunning: boolean; cols?: number; rows?: number }

/** GET /cloud/v1/fleet: the server's agents as shareFleet picks them, live fields from their terminals, and their projects. */
export function fleetAnswer(
  client: CloudClient,
  server: { id: string; name: string },
  agents: Iterable<AgentStatus>,
  liveOf: (agent: AgentStatus) => AgentLive,
): FleetAnswer {
  const withLive: AgentStatus[] = [];
  for (const agent of agents) {
    const { cols: _cols, rows: _rows, cliRunning: _running, ...stored } = agent as AgentStatus & { cols?: unknown; rows?: unknown; cliRunning?: unknown };
    void _cols; void _rows; void _running;
    withLive.push({ ...stored, ...liveOf(agent) } as unknown as AgentStatus);
  }
  const shared = shareFleet(withLive);
  const projects = new Map<string, CloudProject>();
  for (const agent of shared) {
    if (agent.projectPath && !projects.has(agent.projectPath)) projects.set(agent.projectPath, { name: agent.projectName, path: agent.projectPath });
  }
  return { v: 1, server, youMay: [...client.scopes], projects: [...projects.values()], agents: shared };
}
