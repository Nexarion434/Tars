import type { AgentStatus, CloudRemoteAgent, CloudServerStatus, CloudServerView } from '@/types/electron';

/**
 * A Tars server's agents on the Dashboard and the Agents page, and what this
 * window may do to them (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md,
 * Tasks 12 and 13). Ported from win/machines' src/lib/machines.ts (the remote
 * half, read and retyped), whose screens Nicolas validated: a server is shown
 * as another machine is, under its name, with the same badge, filter, offline
 * line and drive bar. Frames: `Dashboard · two machines`, `Panel · machine
 * offline`, `Agents · two machines`, `Panel · machine you may only see`.
 */

/** Where a remote agent runs, on the agent a pane or a card is handed. */
export interface RemoteInfo {
  /** The server's profile id in Settings > Cloud. */
  machineId: string;
  machineName: string;
  status: CloudServerStatus;
  offlineSince?: string;
  /** Its project's path on the server, as given. */
  projectPath: string;
  /** The size its terminal is drawn for there, both or neither. */
  cols?: number;
  rows?: number;
  /** The server lets this desktop start, stop and type into its agents. */
  drive?: boolean;
}

/** An agent of this Tars, or a server's (`remote` set) shaped like it. */
export type PaneAgent = AgentStatus & { remote?: RemoteInfo };

/** The filter: everywhere, this Tars, or one server by its profile id. */
export const ALL_MACHINES = 'all';
export const THIS_MACHINE = 'local';

export interface FleetMachine { id: string; name: string; status: CloudServerStatus }

/** A remote id is `c:<serverId>:<agentId>`, never one of this Tars's own. */
export const isRemoteId = (id: string): boolean => id.startsWith('c:');

/** What names a project across machines: its folder, in lower case, for `/` and `\` alike. */
export function folderKey(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop()?.toLowerCase() ?? '';
}

const KNOWN_STATUS = ['idle', 'running', 'completed', 'error', 'waiting', 'stopped', 'asleep'] as const;

/** A server's agent as the panes and the cards read an agent. Nothing here is writable. */
export function remoteToAgent(r: CloudRemoteAgent): PaneAgent {
  const status = (KNOWN_STATUS as readonly string[]).includes(r.status) ? (r.status as AgentStatus['status']) : 'idle';
  return {
    id: r.id,
    name: r.name,
    character: r.character as AgentStatus['character'],
    provider: r.provider as AgentStatus['provider'],
    model: r.model,
    status,
    currentTask: r.currentTask,
    branchName: r.branch,
    projectPath: r.projectPath,
    cliRunning: r.cliRunning,
    lastActivity: r.lastActivity ?? new Date(0).toISOString(),
    stoppedBy: r.stoppedBy,
    stopReason: r.stopReason,
    skills: [],
    output: [],
    remote: { machineId: r.server.id, machineName: r.server.name, status: r.server.status, offlineSince: r.server.offlineSince, drive: r.server.drive, projectPath: r.projectPath, cols: r.cols, rows: r.rows },
  };
}

/**
 * This Tars's agents, then the servers', each remote one filed under the
 * local project with the same folder name, or under a project of its own.
 */
export function placeRemote(localAgents: AgentStatus[], remote: CloudRemoteAgent[]): PaneAgent[] {
  if (remote.length === 0) return localAgents;
  const byKey = new Map<string, string>();
  for (const a of localAgents) if (!byKey.has(folderKey(a.projectPath))) byKey.set(folderKey(a.projectPath), a.projectPath);
  const placed = remote.map(r => {
    const key = folderKey(r.projectPath);
    // A path with no folder name (a root) matches nothing but itself.
    const known = key ? byKey.get(key) : undefined;
    if (!known && key) byKey.set(key, r.projectPath);
    return { ...remoteToAgent(r), projectPath: known ?? r.projectPath };
  });
  return [...localAgents, ...placed];
}

export function filterByMachine<T extends PaneAgent>(agents: T[], filter: string): T[] {
  if (filter === ALL_MACHINES) return agents;
  if (filter === THIS_MACHINE) return agents.filter(a => !a.remote);
  return agents.filter(a => a.remote?.machineId === filter);
}

/** The filter as it applies: a server that is gone, or none linked, is back to all. */
export function activeFilter(filter: string, machines: FleetMachine[]): string {
  if (machines.length === 0) return ALL_MACHINES;
  if (filter === ALL_MACHINES || filter === THIS_MACHINE) return filter;
  return machines.some(m => m.id === filter) ? filter : ALL_MACHINES;
}

/** A desktop is "this Tars" on every system. */
export const localMachineLabel = (): string => 'This Tars';

export function machineFilterOptions(machines: FleetMachine[]): { value: string; label: string }[] {
  return [
    { value: ALL_MACHINES, label: 'Everywhere' },
    { value: THIS_MACHINE, label: localMachineLabel() },
    ...machines.map(m => ({ value: m.id, label: m.name })),
  ];
}

/** A server's link phase as its agents show it. */
export function serverStatus(phase: CloudServerView['state']['phase']): CloudServerStatus {
  return phase === 'connected' ? 'connected' : phase === 'disconnected' ? 'disconnected' : 'offline';
}

/** The servers: those this desktop holds a credential for, then any an agent names that the list lacks. */
export function fleetMachines(servers: CloudServerView[], agents: CloudRemoteAgent[]): FleetMachine[] {
  const out = new Map<string, FleetMachine>();
  for (const s of servers) if (s.paired) out.set(s.id, { id: s.id, name: s.name ?? s.host, status: serverStatus(s.state.phase) });
  for (const a of agents) if (!out.has(a.server.id)) out.set(a.server.id, { id: a.server.id, name: a.server.name, status: a.server.status });
  return [...out.values()];
}

/** The line over a pane whose server is not connected. Frame: `Panel · machine offline`. */
export function offlineLine(m: { machineName: string; offlineSince?: string; status?: CloudServerStatus }): string {
  if (m.status === 'disconnected') {
    return `${m.machineName} no longer admits this computer. Its last output stays below; forget it in Settings > Cloud and connect again.`;
  }
  const since = m.offlineSince ? new Date(m.offlineSince) : null;
  const at = since && !Number.isNaN(since.getTime())
    ? ` since ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
    : '';
  return `${m.machineName} offline${at}. Its last output stays below, and the pane is live again when ${m.machineName} is back.`;
}

/** The title of an action that would act on a remote agent. */
export const readOnlyTitle = (machineName: string): string => `Read only: this agent runs on ${machineName}`;

/** Under the Dashboard: `srv1539916 ✓`, or `srv1539916 offline`. */
export const machineStatusLabel = (m: FleetMachine): string => (m.status === 'connected' ? `${m.name} ✓` : `${m.name} ${m.status}`);

/** The servers of each project that only remote agents are on, for its tab and its section. */
export function tabMachines(agents: PaneAgent[]): Map<string, string[]> {
  const local = new Set<string>();
  const names = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.remote) { local.add(a.projectPath); continue; }
    const list = names.get(a.projectPath) ?? [];
    if (!list.includes(a.remote.machineName)) list.push(a.remote.machineName);
    names.set(a.projectPath, list);
  }
  for (const path of local) names.delete(path);
  return names;
}

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * The size a remote pane's terminal is drawn at: what the screen came with,
 * else what the agent says, else 120x30. A full-screen CLI places every line by
 * its own terminal's size, so the pane never picks one of its own.
 */
export function remoteSize(
  shot: { cols?: number; rows?: number } | null | undefined,
  agent: { cols?: number; rows?: number } | undefined,
): { cols: number; rows: number } {
  for (const s of [shot, agent]) if (s && isSize(s.cols) && isSize(s.rows)) return { cols: s.cols, rows: s.rows };
  return { cols: 120, rows: 30 };
}

/** The scale that fits a terminal in its pane body: at most 1, and 1 while either size is not known. */
export function scaleToFit(body: { width: number; height: number }, term: { width: number; height: number }): number {
  const ok = [body.width, body.height, term.width, term.height].every(n => Number.isFinite(n) && n > 0);
  return ok ? Math.min(1, body.width / term.width, body.height / term.height) : 1;
}

/**
 * What can be done to a remote agent from here: only on a connected server
 * that lets this desktop drive (it asks again at every action). `type` is keys
 * typed into its pane. `seeOnly` is a server that answers and allows nothing.
 */
export function remoteActions(remote: Pick<RemoteInfo, 'status' | 'drive'>, running: boolean) {
  const connected = remote.status === 'connected';
  const drive = connected && remote.drive === true;
  return { start: drive && !running, stop: drive && running, type: drive, seeOnly: connected && !drive };
}

/** Under a pane of a server that lets this desktop see only. Frame: `Panel · machine you may only see`. */
export function seeOnlyLine(machineName: string): string {
  return `${machineName} lets this Tars see only. To start, stop or type into its agents, it must give this computer drive: forget it in Settings > Cloud and connect again.`;
}

/** The reason a stop is given, or null when it is blank. */
export function checkReason(reason: string): string | null {
  return reason.trim() || null;
}

/** A remote pane takes the size of the pane that looks at it where its server lets this desktop drive; else it draws at the remote size. */
export const sharesSize = (remote: Pick<RemoteInfo, 'status' | 'drive'>): boolean => remote.status === 'connected' && remote.drive === true;

/** Whether a pane sends its size: it is a size, and not the one it sent last. */
export function shouldSendSize(last: { cols: number; rows: number }, next: { cols: number; rows: number }): boolean {
  return isSize(next.cols) && isSize(next.rows) && (next.cols !== last.cols || next.rows !== last.rows);
}

/** Whether the size the fleet reports is the one this pane sent (or took), so reading the screen again would only loop. */
export function fleetMatchesSent(sent: { cols: number; rows: number }, fleet: { cols?: number; rows?: number } | undefined): boolean {
  return !!fleet && isSize(fleet.cols) && isSize(fleet.rows) && fleet.cols === sent.cols && fleet.rows === sent.rows;
}
