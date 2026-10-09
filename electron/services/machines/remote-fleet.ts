import { readFleet, parseRemoteId } from './fleet-share';
import { MAX_KEYS } from './bridge-server';
import type { DriveResult, PairedMachine, PeerStatus, RemoteAgent, RemoteScreen } from './types';

/**
 * The other machines' agents as this one keeps them between polls, and the
 * live outputs the window watches. A machine that stops answering keeps its
 * last agents, marked offline since its first missed poll, so its panes keep
 * their last output; a machine forgotten here takes its agents with it.
 */
export interface RemoteFleetDeps {
  peers: () => PairedMachine[];
  fetchFleet: (peer: PairedMachine) => Promise<{ status: number; body: Record<string, unknown> }>;
  fetchScreen: (peer: PairedMachine, agentId: string) => Promise<RemoteScreen | null>;
  openStream: (peer: PairedMachine, agentId: string, onChunk: (chunk: string) => void, onEnd: () => void) => { close: () => void };
  /** One action on a remote agent, as the other machine answers it (client.ts, driveAgent). */
  driveAgent?: (peer: PairedMachine, agentId: string, action: DriveAction, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Told whenever the list moved: an agent, a status, a machine gone offline or back. */
  onFleet: (agents: RemoteAgent[]) => void;
  /** A watched agent's chunk, under its remote id. */
  onOutput: (remoteId: string, chunk: string) => void;
  now?: () => number;
  later?: (fn: () => void, ms: number) => void;
  /** How long after a watched stream ended it is opened again. */
  retryMs?: number;
  /** How long one machine's poll may take before it counts as not answering. */
  pollTimeoutMs?: number;
}

export type DriveAction = 'start' | 'stop' | 'message' | 'keys' | 'size';

export interface RemoteFleet {
  poll: () => Promise<void>;
  /** An action on a remote agent: done, or the other machine's sentence why not. That machine decides. */
  drive: (remoteId: string, action: DriveAction, body: Record<string, unknown>) => Promise<DriveResult>;
  /** Keys typed in a remote pane: sent in order, one batch on its way per agent, those typed meanwhile gathered behind it. */
  keys: (remoteId: string, data: string) => Promise<DriveResult>;
  /** The size of a remote pane, which that agent's terminal then draws at. */
  resize: (remoteId: string, cols: number, rows: number) => Promise<DriveResult>;
  list: () => RemoteAgent[];
  screen: (remoteId: string) => Promise<RemoteScreen | null>;
  watch: (remoteId: string) => void;
  unwatch: (remoteId: string) => void;
  stop: () => void;
}

interface Kept { agents: RemoteAgent[]; status: PeerStatus; offlineSince?: string }
interface Watched { count: number; stream: { close: () => void } | null; retry: boolean }

export function createRemoteFleet(deps: RemoteFleetDeps): RemoteFleet {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const kept = new Map<string, Kept>();
  const watched = new Map<string, Watched>();
  let told = '';
  /** Per remote agent: the batch on its way, and the keys gathered behind it with those waiting on them. */
  const typing = new Map<string, { sending: boolean; pending: string; waiters: Array<(r: DriveResult) => void> }>();
  let stopped = false;

  const peerOf = (machineId: string) => deps.peers().find(p => p.id === machineId);

  const list = (): RemoteAgent[] => [...kept.values()].flatMap(k => k.agents);

  async function answerOf(peer: PairedMachine): Promise<{ status: number; body: Record<string, unknown> }> {
    let timer: NodeJS.Timeout | undefined;
    const silent = new Promise<{ status: number; body: Record<string, unknown> }>(resolve => {
      timer = setTimeout(() => resolve({ status: 0, body: {} }), deps.pollTimeoutMs ?? 6_000);
    });
    try {
      return await Promise.race([deps.fetchFleet(peer).catch(() => ({ status: 0, body: {} })), silent]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function poll(): Promise<void> {
    const peers = deps.peers();
    for (const id of [...kept.keys()]) if (!peers.some(p => p.id === id)) kept.delete(id);
    forgetWatched(peers);
    await Promise.all(peers.map(async peer => {
      const r = await answerOf(peer);
      const before = kept.get(peer.id);
      if (r.status === 200) {
        // Drivable only while it says it lets this machine drive; it checks each action again.
        const drive = r.body.youMay === 'drive';
        kept.set(peer.id, { status: 'connected', agents: readFleet(r.body, { id: peer.id, name: peer.name, status: 'connected', drive }) });
        return;
      }
      // Not answering, or no longer pairing with this one: its last agents stay, marked.
      const status: PeerStatus = r.status === 401 ? 'unpaired' : 'offline';
      const offlineSince = before && before.status !== 'connected' ? before.offlineSince : new Date(now()).toISOString();
      const machine = { id: peer.id, name: peer.name, status, offlineSince, drive: false };
      kept.set(peer.id, { status, offlineSince, agents: (before?.agents ?? []).map(a => ({ ...a, machine })) });
    }));
    if (stopped) return;
    const agents = list();
    const shown = JSON.stringify(agents);
    if (shown !== told) {
      told = shown;
      deps.onFleet(agents);
    }
  }

  function open(remoteId: string, machineId: string, agentId: string, again = false): void {
    const w = watched.get(remoteId);
    const peer = peerOf(machineId);
    if (!w || w.count === 0 || stopped || !peer) return;
    const relay = (chunk: string) => { if (watched.get(remoteId) === w && w.count > 0) deps.onOutput(remoteId, chunk); };
    // Opened again after an end: what the pane missed meanwhile comes back as
    // the screen, drawn first, and what the stream brings waits behind it.
    let held: string[] | null = again ? [] : null;
    let ended = false;
    const stream = deps.openStream(peer, agentId, (chunk) => {
      if (held) held.push(chunk); else relay(chunk);
    }, () => {
      ended = true;
      if (w.stream === stream) w.stream = null;
      // Ended under a pane that still watches: opened again, should its machine
      // be back, unless that pane has gone and another watches since.
      if (watched.get(remoteId) === w && w.count > 0 && !w.retry) {
        w.retry = true;
        later(() => {
          w.retry = false;
          if (watched.get(remoteId) === w) open(remoteId, machineId, agentId, true);
        }, deps.retryMs ?? 3_000);
      }
    });
    if (!ended) w.stream = stream;
    if (held) {
      void deps.fetchScreen(peer, agentId).catch(() => null).then(screen => {
        const waiting = held ?? [];
        held = null;
        if (screen) relay(screen.screen);
        waiting.forEach(relay);
      });
    }
  }

  /** Closes what the window watches of machines no longer paired here. */
  function forgetWatched(peers: PairedMachine[]): void {
    for (const [remoteId, w] of [...watched]) {
      const parsed = parseRemoteId(remoteId);
      if (parsed && peers.some(p => p.id === parsed.machineId)) continue;
      watched.delete(remoteId);
      w.count = 0;
      w.stream?.close();
      w.stream = null;
    }
  }

  async function drive(remoteId: string, action: DriveAction, body: Record<string, unknown>): Promise<DriveResult> {
    const parsed = parseRemoteId(remoteId);
    const peer = parsed && peerOf(parsed.machineId);
    if (!parsed || !peer || !deps.driveAgent) return { success: false, error: 'There is no such agent.' };
    const r = await deps.driveAgent(peer, parsed.agentId, action, body).catch(() => ({ status: 0, body: {} as Record<string, unknown> }));
    if (r.status === 200) return { success: true };
    if (r.status === 0) {
      return { success: false, error: action === 'start' ? `${peer.name} did not answer in time. The agent may have started anyway.` : `${peer.name} did not answer.` };
    }
    // One line, without controls or format characters (bidi, zero width): it is shown as it is.
    const said = typeof r.body.error === 'string' ? r.body.error.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return { success: false, error: said || `${peer.name} refused it (${r.status}).` };
  }

  /**
   * Sends what has gathered for one agent, in batches the other side takes
   * (MAX_KEYS, never cutting a character in two), then what gathered
   * meanwhile, until nothing waits. A batch refused, or one that throws, ends
   * its burst: the rest of it would land out of context.
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
    poll,
    list,
    resize: (remoteId, cols, rows) => drive(remoteId, 'size', { cols, rows }),
    keys: (remoteId, data) => {
      if (!parseRemoteId(remoteId)) return Promise.resolve({ success: false, error: 'There is no such agent.' });
      const t = typing.get(remoteId) ?? { sending: false, pending: '', waiters: [] };
      typing.set(remoteId, t);
      t.pending += data;
      const answer = new Promise<DriveResult>(resolve => { t.waiters.push(resolve); });
      void flush(remoteId);
      return answer;
    },
    drive,
    screen: async (remoteId) => {
      const parsed = parseRemoteId(remoteId);
      const peer = parsed && peerOf(parsed.machineId);
      return peer ? deps.fetchScreen(peer, parsed!.agentId).catch(() => null) : null;
    },
    watch: (remoteId) => {
      const parsed = parseRemoteId(remoteId);
      if (!parsed || !peerOf(parsed.machineId)) return;
      const w = watched.get(remoteId) ?? { count: 0, stream: null, retry: false };
      watched.set(remoteId, w);
      w.count++;
      if (w.count === 1 && !w.stream && !w.retry) open(remoteId, parsed.machineId, parsed.agentId);
    },
    unwatch: (remoteId) => {
      const w = watched.get(remoteId);
      if (!w) return;
      w.count = Math.max(0, w.count - 1);
      if (w.count > 0) return;
      watched.delete(remoteId);
      const stream = w.stream;
      w.stream = null;
      stream?.close();
    },
    stop: () => {
      stopped = true;
      for (const w of watched.values()) { w.count = 0; w.stream?.close(); }
      watched.clear();
    },
  };
}
