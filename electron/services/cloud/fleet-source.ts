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

/** GET /cloud/v1/fleet: the server's agents as shareFleet picks them, and the projects they are in. */
export function fleetAnswer(client: CloudClient, server: { id: string; name: string }, agents: Iterable<AgentStatus>): FleetAnswer {
  const shared = shareFleet(agents);
  const projects = new Map<string, CloudProject>();
  for (const agent of shared) {
    if (agent.projectPath && !projects.has(agent.projectPath)) projects.set(agent.projectPath, { name: agent.projectName, path: agent.projectPath });
  }
  return { v: 1, server, youMay: [...client.scopes], projects: [...projects.values()], agents: shared };
}
