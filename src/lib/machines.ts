import type { AgentStatus, MachineView, MachinesView, PeerStatus, RemoteAgent } from '@/types/electron';

/**
 * The words Settings > Machines writes under each paired machine. Frame:
 * `Settings · Machines` in design/tars-redesign.pen.
 */

/** "now", "2 min ago", "3 h ago", "3 days ago"; a time ahead of this clock reads now. */
export function seenAgo(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

export function statusLine(m: MachineView, now: Date): string {
  if (m.status === 'unpaired') return `${m.name} no longer knows this machine. Forget it here, and pair again if you want.`;
  if (m.status === 'connected') {
    const n = m.agentsRunning ?? 0;
    return `${n} ${n === 1 ? 'agent' : 'agents'} running · seen ${seenAgo(m.lastSeen, now)}`;
  }
  return m.lastSeen ? `offline · last seen ${seenAgo(m.lastSeen, now)}` : 'offline · not seen since Tars started';
}

/**
 * What the address row says in place of the address, or null to show it:
 * that Tailscale is off, or why the bridge cannot listen while machines are
 * paired. A bridge with nothing paired and no code shown is not started, and
 * that is no fault.
 */
export function addressNote(view: Pick<MachinesView, 'tailscale' | 'bridge' | 'peers'>): string | null {
  if (!view.tailscale.running) return 'Tailscale is not running';
  if (!view.bridge.listening && view.bridge.reason && view.peers.length > 0) return view.bridge.reason;
  return null;
}

/** "4:52": what is left until a time, never below 0:00. */
export function timeLeft(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * What the machine showing the code says when another knocks and waits:
 * who asks, by the MagicDNS name the tailnet keeps unique when Tailscale
 * lists it, and its address, and how long it waits. Frame: `Settings ·
 * Machines · a machine asks to pair`.
 */
export function requestLine(r: NonNullable<MachinesView['request']>, now: Date): string {
  const who = r.device ? `${r.name} wants to pair with this machine. Tailscale knows it as ${r.device}, ${r.address}.` : `${r.name} wants to pair with this machine, from ${r.address}.`;
  return `${who} Accept only if you just typed this machine's code there. It waits ${timeLeft(r.expiresAt, now)} for your answer.`;
}

/**
 * The agents of the other machines on the Dashboard and the Agents page, read
 * only. Frames: `Dashboard · two machines`, `Panel · machine offline`,
 * `Agents · two machines` in design/tars-redesign.pen.
 */

/** Where a remote agent runs, on the agent a pane or a card is handed. */
export interface RemoteInfo {
  machineId: string;
  machineName: string;
  status: PeerStatus;
  offlineSince?: string;
  /** Its project's path on its own machine, as given. */
  projectPath: string;
  /** The size its terminal is drawn for there, both or neither. */
  cols?: number;
  rows?: number;
  /** Its machine lets this one start, stop and type into its agents. */
  drive?: boolean;
}

/** An agent of this machine, or a remote one (`remote` set) shaped like it. */
export type PaneAgent = AgentStatus & { remote?: RemoteInfo };

/** The machine filter: every machine, this one, or one machine by id. */
export const ALL_MACHINES = 'all';
export const THIS_MACHINE = 'local';

export interface FleetMachine { id: string; name: string; status: PeerStatus }

/** A remote id is `m:<machineId>:<agentId>`, never one of this machine's own. */
export const isRemoteId = (id: string): boolean => id.startsWith('m:');

/** What names a project across machines: its folder, in lower case, for `/` and `\` alike. */
export function folderKey(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop()?.toLowerCase() ?? '';
}

const KNOWN_STATUS = ['idle', 'running', 'completed', 'error', 'waiting', 'stopped', 'asleep'] as const;

/** A remote agent as the panes and the cards read an agent. Nothing here is writable. */
export function remoteToAgent(r: RemoteAgent): PaneAgent {
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
    remote: { machineId: r.machine.id, machineName: r.machine.name, status: r.machine.status, offlineSince: r.machine.offlineSince, drive: r.machine.drive, projectPath: r.projectPath, cols: r.cols, rows: r.rows },
  };
}

/**
 * This machine's agents, then the others', each remote one filed under the
 * local project with the same folder name, or under a project of its own
 * (one per folder name, whatever machine it is on).
 */
export function placeRemote(localAgents: AgentStatus[], remote: RemoteAgent[]): PaneAgent[] {
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

/** The filter as it applies: a machine that is gone, or none paired, is back to all. */
export function activeFilter(filter: string, machines: FleetMachine[]): string {
  if (machines.length === 0) return ALL_MACHINES;
  if (filter === ALL_MACHINES || filter === THIS_MACHINE) return filter;
  return machines.some(m => m.id === filter) ? filter : ALL_MACHINES;
}

export function localMachineLabel(platform: string): string {
  if (platform === 'darwin') return 'This Mac';
  if (platform === 'win32') return 'This PC';
  return 'This machine';
}

export function machineFilterOptions(machines: FleetMachine[], platform: string): { value: string; label: string }[] {
  return [
    { value: ALL_MACHINES, label: 'All machines' },
    { value: THIS_MACHINE, label: localMachineLabel(platform) },
    ...machines.map(m => ({ value: m.id, label: m.name })),
  ];
}

/** The other machines: the paired ones, then any an agent names that the list lacks. */
export function fleetMachines(peers: FleetMachine[], agents: RemoteAgent[]): FleetMachine[] {
  const out = new Map<string, FleetMachine>();
  for (const p of peers) if (p.status !== 'unpaired') out.set(p.id, { id: p.id, name: p.name, status: p.status });
  for (const a of agents) if (!out.has(a.machine.id)) out.set(a.machine.id, { id: a.machine.id, name: a.machine.name, status: a.machine.status });
  return [...out.values()];
}

/** The line over an offline machine's pane. Frame: `Panel · machine offline`. */
export function offlineLine(m: { machineName: string; offlineSince?: string }): string {
  const since = m.offlineSince ? new Date(m.offlineSince) : null;
  const at = since && !Number.isNaN(since.getTime())
    ? ` since ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
    : '';
  return `${m.machineName} offline${at}. Its last output stays below, and the pane is live again when the ${m.machineName} is back.`;
}

/** The title of an action that would act on a remote agent. */
export const readOnlyTitle = (machineName: string): string => `Read only: this agent runs on ${machineName}`;

/** Under the Dashboard: `PC ✓`, or `PC offline`. */
export const machineStatusLabel = (m: FleetMachine): string => (m.status === 'connected' ? `${m.name} ✓` : `${m.name} offline`);

/** The machines of each project that only remote agents are on, for its tab and its section. */
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
 * What can be done to a remote agent from here: only on a connected machine
 * that lets this one drive (its own Settings decides, and it asks again at
 * every action). `type` is keys typed into its pane. `seeOnly` is the machine
 * that answers and allows nothing.
 */
export function remoteActions(remote: Pick<RemoteInfo, 'status' | 'drive'>, running: boolean) {
  const connected = remote.status === 'connected';
  const drive = connected && remote.drive === true;
  return { start: drive && !running, stop: drive && running, type: drive, seeOnly: connected && !drive };
}

/** Under a pane of a machine that lets this one see only. Frame: `Panel · machine you may only see`. */
export function seeOnlyLine(machineName: string, platform: string): string {
  const me = localMachineLabel(platform).replace('This ', 'this ');
  return `${machineName} lets ${me} see only. To start, stop or type into its agents, choose Drive for ${me} on ${machineName}, in Settings > Machines.`;
}

/** The reason a stop is given, or null when it is blank. */
export function checkReason(reason: string): string | null {
  return reason.trim() || null;
}
