import { MAX_KEYS } from '../cloud/drive';
import { shareAgent, MAX_SHARED_AGENTS, type SharedAgent } from '../cloud/fleet-share';
import type { DoorAnswer, DoorClient, DriveAction, StreamEnd } from './client';
import type { LinkPhase } from './link';

/**
 * A Tars server's agents as the desktop keeps them between polls, the live
 * outputs the window watches, and the keys it types
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 8). Ported from
 * win/machines' electron/services/machines/remote-fleet.ts, read and retyped,
 * for servers this desktop is linked to instead of paired machines.
 *
 * A server that stops answering keeps its last agents, marked offline since
 * its first missed poll, so its panes keep their last output; one forgotten
 * here takes its agents with it. A 401 from the door, on a poll, a drive or a
 * stream, is told to the link (which disconnects) and never retried here.
 */

export interface CloudServer {
  /** The profile's id in cloud-link.json. */
  id: string;
  serverId: string;
  name: string;
}

export type ServerStatus = 'connected' | 'offline' | 'disconnected';
export interface ServerTag { id: string; serverId: string; name: string; status: ServerStatus; offlineSince?: string; drive: boolean }
export type RemoteAgent = Omit<SharedAgent, 'agentId'> & { id: string; agentId: string; server: ServerTag };
export interface RemoteScreen { screen: string; cliRunning: boolean; cols?: number; rows?: number }
export type DriveResult = { success: true } | { success: false; error: string };

export interface RemoteFleetDeps {
  /** The servers with a known server id. */
  servers: () => CloudServer[];
  /** The door's client while the link is connected, its phase otherwise. */
  link: (server: CloudServer) => { client: DoorClient } | { phase: LinkPhase };
  /** The door refused this desktop's credential (link.refused). */
  refused: (profileId: string) => void;
  /** Told whenever the list moved: an agent, a status, a server gone offline or back. */
  onFleet: (agents: RemoteAgent[]) => void;
  /** A watched agent's chunk, under its remote id. */
  onOutput: (remoteId: string, chunk: string) => void;
  now?: () => number;
  later?: (fn: () => void, ms: number) => void;
  /** How long after a watched stream ended it is opened again. */
  retryMs?: number;
  /** How long one server's poll may take before it counts as not answering. */
  pollTimeoutMs?: number;
}

export interface RemoteFleet {
  poll(): Promise<void>;
  list(): RemoteAgent[];
  /** An action on a remote agent: done, or the server's sentence why not. The server decides. */
  drive(remoteId: string, action: DriveAction, body: Record<string, unknown>): Promise<DriveResult>;
  /** Keys typed in a remote pane: in order, one batch on its way per agent, those typed meanwhile gathered behind it. */
  keys(remoteId: string, data: string): Promise<DriveResult>;
  resize(remoteId: string, cols: number, rows: number): Promise<DriveResult>;
  screen(remoteId: string): Promise<RemoteScreen | null>;
  watch(remoteId: string): void;
  unwatch(remoteId: string): void;
  stop(): void;
}

const SERVER_ID = /^[0-9a-f]{16}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NO_SUCH_AGENT = 'There is no such agent.';

/** The id this desktop gives a server's agent: never one of its own fleet, which has no colon. */
export const cloudId = (serverId: string, agentId: string): string => `c:${serverId}:${agentId}`;

/** The server and the agent a remote id names, or null for any other id. */
export function parseCloudId(id: string): { serverId: string; agentId: string } | null {
  const m = /^c:([^:]+):([^:]+)$/.exec(id);
  return m && SERVER_ID.test(m[1]) && AGENT_ID.test(m[2]) ? { serverId: m[1], agentId: m[2] } : null;
}

/** A server's agents from its fleet answer, picked and bounded as the server's share picks them. */
function readFleet(body: Record<string, unknown>, server: ServerTag): RemoteAgent[] {
  const list = Array.isArray(body.agents) ? body.agents : [];
  const out: RemoteAgent[] = [];
  for (const item of list) {
    if (out.length >= MAX_SHARED_AGENTS) break;
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const shared = shareAgent({ ...source, id: source.agentId, branchName: source.branch } as never);
    if (!shared) continue;
    const { agentId, ...fields } = shared;
    out.push({ ...fields, id: cloudId(server.serverId, agentId), agentId, server });
  }
  return out;
}

/** One line, without controls or format characters (bidi, zero width): it is shown as it is. */
const sentenceOf = (answer: DoorAnswer): string =>
  typeof answer.body.error === 'string' ? answer.body.error.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';

interface Kept { agents: RemoteAgent[]; status: ServerStatus; offlineSince?: string }
interface Watched { count: number; stream: { close(): void } | null; retry: boolean }

export function createRemoteFleet(deps: RemoteFleetDeps): RemoteFleet {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const kept = new Map<string, Kept>();
  const watched = new Map<string, Watched>();
  const typing = new Map<string, { sending: boolean; pending: string; waiters: Array<(r: DriveResult) => void> }>();
  let told = '';
  let polling: Promise<void> | null = null;
  let stopped = false;

  const list = (): RemoteAgent[] => [...kept.values()].flatMap(k => k.agents);
  const serverOf = (serverId: string) => deps.servers().find(s => s.serverId === serverId);
  const clientOf = (server: CloudServer) => {
    const link = deps.link(server);
    return 'client' in link ? link.client : null;
  };

  async function answerOf(client: DoorClient): Promise<DoorAnswer> {
    let timer: NodeJS.Timeout | undefined;
    const silent = new Promise<DoorAnswer>(resolve => {
      timer = setTimeout(() => resolve({ status: 0, body: {} }), deps.pollTimeoutMs ?? 6_000);
    });
    try {
      return await Promise.race([client.fleet().catch(() => ({ status: 0, body: {} })), silent]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollOnce(): Promise<void> {
    const servers = deps.servers();
    for (const id of [...kept.keys()]) if (!servers.some(s => s.id === id)) kept.delete(id);
    forgetWatched(servers);
    await Promise.all(servers.map(async server => {
      const link = deps.link(server);
      const answer = 'client' in link ? await answerOf(link.client) : null;
      const before = kept.get(server.id);
      if (answer?.status === 200) {
        // Drivable only while the server says so; it checks each action again.
        const drive = Array.isArray(answer.body.youMay) && answer.body.youMay.includes('drive');
        const tag: ServerTag = { id: server.id, serverId: server.serverId, name: server.name, status: 'connected', drive };
        kept.set(server.id, { status: 'connected', agents: readFleet(answer.body, tag) });
        return;
      }
      if (answer?.status === 401) deps.refused(server.id);
      const status: ServerStatus = answer?.status === 401 || ('phase' in link && link.phase === 'disconnected') ? 'disconnected' : 'offline';
      const offlineSince = before && before.status !== 'connected' ? before.offlineSince : new Date(now()).toISOString();
      const tag: ServerTag = { id: server.id, serverId: server.serverId, name: server.name, status, offlineSince, drive: false };
      kept.set(server.id, { status, offlineSince, agents: (before?.agents ?? []).map(a => ({ ...a, server: tag })) });
    }));
    if (stopped) return;
    const agents = list();
    const shown = JSON.stringify(agents);
    if (shown !== told) {
      told = shown;
      deps.onFleet(agents);
    }
  }

  function open(remoteId: string, serverId: string, agentId: string, again = false): void {
    const w = watched.get(remoteId);
    const server = serverOf(serverId);
    const client = server && clientOf(server);
    if (!w || w.count === 0 || stopped || !server || !client) return;
    const relay = (chunk: string) => { if (watched.get(remoteId) === w && w.count > 0) deps.onOutput(remoteId, chunk); };
    // Opened again after an end: what the pane missed comes back as the
    // screen, drawn first, and what the stream brings waits behind it.
    let held: string[] | null = again ? [] : null;
    let ended = false;
    const stream = client.stream(agentId, chunk => {
      if (held) held.push(chunk); else relay(chunk);
    }, (how: StreamEnd) => {
      ended = true;
      if (w.stream === stream) w.stream = null;
      if (how.reason === 'revoked' || (how.reason === 'refused' && how.status === 401)) return deps.refused(server.id);
      if (how.reason === 'refused' || how.reason === 'closed') return;
      if (watched.get(remoteId) === w && w.count > 0 && !w.retry) {
        w.retry = true;
        later(() => {
          w.retry = false;
          if (watched.get(remoteId) === w) open(remoteId, serverId, agentId, true);
        }, deps.retryMs ?? 3_000);
      }
    });
    if (!ended) w.stream = stream;
    if (held) {
      void screenOf(client, agentId).then(screen => {
        const waiting = held ?? [];
        held = null;
        if (screen) relay(screen.screen);
        waiting.forEach(relay);
      });
    }
  }

  async function screenOf(client: DoorClient, agentId: string): Promise<RemoteScreen | null> {
    const answer = await client.screen(agentId).catch(() => null);
    const body = answer?.status === 200 ? answer.body : null;
    if (!body || typeof body.screen !== 'string') return null;
    const size = typeof body.cols === 'number' && typeof body.rows === 'number' ? { cols: body.cols, rows: body.rows } : {};
    return { screen: body.screen, cliRunning: body.cliRunning === true, ...size };
  }

  /** Closes what the window watches of servers no longer here. */
  function forgetWatched(servers: CloudServer[]): void {
    for (const [remoteId, w] of [...watched]) {
      const parsed = parseCloudId(remoteId);
      if (parsed && servers.some(s => s.serverId === parsed.serverId)) continue;
      watched.delete(remoteId);
      w.count = 0;
      w.stream?.close();
      w.stream = null;
    }
  }

  async function drive(remoteId: string, action: DriveAction, body: Record<string, unknown>): Promise<DriveResult> {
    const parsed = parseCloudId(remoteId);
    const server = parsed && serverOf(parsed.serverId);
    if (!parsed || !server) return { success: false, error: NO_SUCH_AGENT };
    const client = clientOf(server);
    if (!client) return { success: false, error: `${server.name} is not connected.` };
    const answer = await client.drive(parsed.agentId, action, body).catch(() => ({ status: 0, body: {} }));
    if (answer.status === 200) return { success: true };
    if (answer.status === 0) {
      return { success: false, error: action === 'start' ? `${server.name} did not answer in time. The agent may have started anyway.` : `${server.name} did not answer.` };
    }
    if (answer.status === 401) deps.refused(server.id);
    return { success: false, error: sentenceOf(answer) || `${server.name} refused it (${answer.status}).` };
  }

  /**
   * Sends what has gathered for one agent, in batches the server takes
   * (MAX_KEYS, never cutting a character in two), then what gathered
   * meanwhile. A batch refused, or one that throws, ends its burst: the rest
   * of it would land out of context.
   */
  async function flush(remoteId: string): Promise<void> {
    const t = typing.get(remoteId);
    if (!t || t.sending || !t.pending) return;
    t.sending = true;
    let data = t.pending;
    const waiters = t.waiters;
    t.pending = '';
    t.waiters = [];
    let result: DriveResult = { success: true };
    try {
      while (data && result.success) {
        let cut = Math.min(data.length, MAX_KEYS);
        if (cut < data.length && /[\uD800-\uDBFF]/.test(data[cut - 1])) cut -= 1;
        result = await drive(remoteId, 'keys', { data: data.slice(0, cut) });
        data = data.slice(cut);
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      waiters.forEach(w => w(result));
      t.sending = false;
      if (t.pending) void flush(remoteId);
      else typing.delete(remoteId);
    }
  }

  return {
    poll() {
      // One fleet request per server in flight at most: a poll asked meanwhile is that one.
      polling ??= pollOnce().finally(() => { polling = null; });
      return polling;
    },
    list,
    drive,
    resize: (remoteId, cols, rows) => drive(remoteId, 'size', { cols, rows }),
    keys(remoteId, data) {
      if (!parseCloudId(remoteId)) return Promise.resolve({ success: false, error: NO_SUCH_AGENT });
      const t = typing.get(remoteId) ?? { sending: false, pending: '', waiters: [] };
      typing.set(remoteId, t);
      t.pending += data;
      const answer = new Promise<DriveResult>(resolve => { t.waiters.push(resolve); });
      void flush(remoteId);
      return answer;
    },
    async screen(remoteId) {
      const parsed = parseCloudId(remoteId);
      const server = parsed && serverOf(parsed.serverId);
      const client = server && clientOf(server);
      return client ? screenOf(client, parsed!.agentId) : null;
    },
    watch(remoteId) {
      const parsed = parseCloudId(remoteId);
      if (!parsed || !serverOf(parsed.serverId)) return;
      const w = watched.get(remoteId) ?? { count: 0, stream: null, retry: false };
      watched.set(remoteId, w);
      w.count++;
      if (w.count === 1 && !w.stream && !w.retry) open(remoteId, parsed.serverId, parsed.agentId);
    },
    unwatch(remoteId) {
      const w = watched.get(remoteId);
      if (!w) return;
      w.count = Math.max(0, w.count - 1);
      if (w.count > 0) return;
      watched.delete(remoteId);
      const stream = w.stream;
      w.stream = null;
      stream?.close();
    },
    stop() {
      stopped = true;
      for (const w of watched.values()) { w.count = 0; w.stream?.close(); }
      watched.clear();
    },
  };
}
