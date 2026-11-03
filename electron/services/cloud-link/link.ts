import { oneLine } from '../cloud/fleet-share';
import { problemSentence, type runServerCommand, type RunResult, type SshProblem } from './remote-run';
import { remoteSocketProblem, type LocalEnd } from './ssh';
import { forgetProfile, readLink, saveProfile, type ServerProfile } from './store';

/**
 * The desktop's link to its Tars servers (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Tasks 4 to 6).
 *
 * Connect: `status` over SSH; a server that is down is started once and asked
 * again; its `serverId` must be the one this profile knows (a server rebuilt on
 * the same home keeps it, another server does not); the first connect mints
 * this desktop's credential, named after this machine, and keeps it; then the
 * forward to the server's door, and `hello` through it, before the credential
 * is ever handed on. Disconnect and Forget end the local `ssh` only: nothing
 * here stops the server.
 *
 * One retry owner per server: a forward that ends (sleep, a network gone,
 * keep-alive silence) is offline at once and tried again after a jittered
 * backoff, doubling from 2 s and capped at 5 min, started over once a link
 * held for a minute (after T3 Code's docs/internals/connection-runtime.md,
 * MIT, © 2026 T3 Tools Inc.). A retry stops at a problem only the user can
 * fix, and a door refusing the credential (401) is disconnected, not retried.
 */

export type LinkProblem = 'not-started' | 'another-server' | 'no-door' | 'no-door-on-host' | 'mint-refused' | 'unknown-server';
export type LinkPhase = 'off' | 'connecting' | 'connected' | 'offline' | 'disconnected' | 'failed';

export interface LinkState {
  phase: LinkPhase;
  since?: string;
  problem?: SshProblem | LinkProblem;
  sentence?: string;
}

/** The long `ssh -N -L` (forward.ts), as the link holds it. */
export interface LinkForward {
  end: LocalEnd;
  ready: Promise<void>;
  ended: Promise<{ code: number | null; stderr: string }>;
  close(): void;
}
/** Opens the forward; a local end that cannot be had throws (or rejects) before any `ssh` starts. */
export type ForwardFactory = (profile: ServerProfile, remoteSocket: string) => LinkForward | Promise<LinkForward>;

export type HelloResult = { ok: true; serverId: string } | { ok: false; status?: number; detail: string };
/** The door through the forward (client.ts); `hello` is the one call made without the credential. */
export interface LinkClient { hello(): Promise<HelloResult> }
export type ClientFactory = (end: LocalEnd) => LinkClient;

export interface CloudLinkDeps {
  file: string;
  run: typeof runServerCommand;
  hostname: () => string;
  forward: ForwardFactory;
  client: ClientFactory;
  now?: () => number;
  /** Runs `fn` once after `ms`, and returns its cancel: the retry owner's only clock. */
  later?: (fn: () => void, ms: number) => () => void;
  random?: () => number;
}

export interface CloudLink {
  connect(id: string): Promise<void>;
  disconnect(id: string): void;
  forget(id: string): Promise<void>;
  /** The door refused this desktop's credential (a 401): disconnected, no retry, no new mint. */
  refused(id: string): void;
  /** Quitting: every local `ssh` ends, every retry is dropped, the servers are sent nothing. */
  closeAll(): void;
  /** The forward's local end while connected, which the door's client goes through; null otherwise. */
  end(id: string): LocalEnd | null;
  state(id: string): LinkState;
  onState(fn: (id: string, state: LinkState) => void): () => void;
}

const SERVER_ID = /^[0-9a-f]{16}$/;
const CLIENT_ID = /^c_[0-9a-f]{8}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
/** What this desktop may do on its server in M2. */
// M3, Nicolas's decision 3: a new device may create; an existing one gets it only by Forget then Connect.
const DESKTOP_SCOPES = ['see', 'drive', 'create'];
const RETRY_FIRST_MS = 2_000;
const RETRY_CAP_MS = 5 * 60_000;
/** A link that held this long starts its next backoff over. */
const RETRY_RESET_MS = 60_000;
/** The problems a retry may outlast; any other waits for the user (a host key, a key, sudo, another server). */
const PASSING = new Set<string>(['unreachable', 'timeout', 'failed', 'container-stopped', 'not-started', 'no-door']);

/** The wait before retry `n` (from 0): doubling from 2 s, capped at 5 min, jittered over its upper half. */
export function retryDelay(n: number, random: () => number): number {
  const base = Math.min(RETRY_FIRST_MS * 2 ** n, RETRY_CAP_MS);
  return Math.round(base / 2 + (random() * base) / 2);
}

function linkSentence(problem: LinkProblem, host: string): string {
  switch (problem) {
    case 'not-started': return `The server on ${host} did not start. Its log is in .tars-private/logs/server.log there.`;
    case 'another-server': return `This is not the server you connected to: ${host} answers as another Tars server. If it was replaced on purpose, forget it here and connect again.`;
    case 'no-door': return `The server on ${host} runs, but its door is not there. Check the door socket path in this server's settings.`;
    case 'no-door-on-host': return `The server on ${host} runs in Docker and does not say where its door is on the host. Enter the door path under Advanced in Settings > Cloud.`;
    case 'mint-refused': return `The server on ${host} did not give this computer a credential Tars can use.`;
    case 'unknown-server': return 'This server is not in Settings any more.';
  }
}

export function createCloudLink(deps: CloudLinkDeps): CloudLink {
  const now = deps.now ?? Date.now;
  const states = new Map<string, LinkState>();
  const listeners = new Set<(id: string, state: LinkState) => void>();
  const forwards = new Map<string, LinkForward>();
  const connecting = new Map<string, Promise<void>>();
  /** Bumped by Disconnect and Forget: a connect that started before them stops at its next step. */
  const generation = new Map<string, number>();
  const later = deps.later ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  const random = deps.random ?? Math.random;
  /** The armed retry's cancel, per server, and the retries run since its link last held. */
  const retries = new Map<string, () => void>();
  const tries = new Map<string, number>();

  const set = (id: string, state: LinkState) => {
    states.set(id, state);
    for (const fn of listeners) fn(id, state);
  };
  const find = (id: string) => readLink(deps.file).servers.find(server => server.id === id);
  const failSsh = (id: string, host: string, result: Extract<RunResult, { ok: false }>) =>
    set(id, { phase: 'failed', problem: result.problem, sentence: problemSentence(result.problem, host) });
  const failLink = (id: string, host: string, problem: LinkProblem) =>
    set(id, { phase: 'failed', problem, sentence: linkSentence(problem, host) });
  const closeForward = (id: string) => {
    forwards.get(id)?.close();
    forwards.delete(id);
  };
  const cancelRetry = (id: string) => {
    retries.get(id)?.();
    retries.delete(id);
  };
  /** Ends what runs for `id` on this computer; a connect in flight stops at its next step. */
  const stop = (id: string) => {
    generation.set(id, (generation.get(id) ?? 0) + 1);
    cancelRetry(id);
    closeForward(id);
  };

  function attempt(id: string): Promise<void> {
    if (forwards.has(id) && states.get(id)?.phase === 'connected') return Promise.resolve();
    const running = connecting.get(id);
    if (running) return running;
    const next = connectOnce(id).finally(() => connecting.delete(id));
    connecting.set(id, next);
    return next;
  }

  /** Arms the one retry for `id`; a retry that fails on a passing problem arms the next. */
  function retryLater(id: string, since: string): void {
    cancelRetry(id);
    const n = tries.get(id) ?? 0;
    tries.set(id, n + 1);
    const ticket = generation.get(id) ?? 0;
    const current = () => (generation.get(id) ?? 0) === ticket;
    retries.set(id, later(() => {
      retries.delete(id);
      if (!current()) return;
      void attempt(id).then(() => {
        const state = states.get(id);
        if (!current() || state?.phase !== 'failed' || !state.problem || !PASSING.has(state.problem)) return;
        set(id, { phase: 'offline', since, problem: state.problem, sentence: state.sentence });
        retryLater(id, since);
      });
    }, retryDelay(n, random)));
  }

  async function connectOnce(id: string): Promise<void> {
    const ticket = generation.get(id) ?? 0;
    const current = () => (generation.get(id) ?? 0) === ticket;
    const profile = find(id);
    if (!profile) return failLink(id, '', 'unknown-server');
    const host = profile.host;
    set(id, { phase: 'connecting' });

    let status = await deps.run(profile, { do: 'status' });
    const down = (s: RunResult) => (s.ok ? s.json.running === false : s.problem === 'container-stopped');
    if (down(status)) {
      const started = await deps.run(profile, { do: 'start' });
      if (!current()) return;
      if (!started.ok) return failSsh(id, host, started);
      status = await deps.run(profile, { do: 'status' });
    }
    if (!current()) return;
    if (!status.ok) return down(status) ? failLink(id, host, 'not-started') : failSsh(id, host, status);
    if (status.json.running !== true) return failLink(id, host, 'not-started');
    const serverId = status.json.serverId;
    if (typeof serverId !== 'string' || !SERVER_ID.test(serverId)) return failSsh(id, host, { ok: false, problem: 'unreadable', detail: '' });
    if (profile.serverId !== undefined && profile.serverId !== serverId) return failLink(id, host, 'another-server');

    let linked = profile;
    if (linked.credential === undefined) {
      const minted = await deps.run(profile, { do: 'clients-add' }, {
        // Its kind says desktop; the server adds "(machine)" to what this one does there.
        stdin: { name: deps.hostname().slice(0, 48), kind: 'desktop', scopes: DESKTOP_SCOPES },
      });
      if (!current()) return;
      if (!minted.ok) return failSsh(id, host, minted);
      const { id: clientId, credential, serverId: mintedFor } = minted.json;
      if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId) || typeof credential !== 'string' || !CREDENTIAL.test(credential) || mintedFor !== serverId) {
        return failLink(id, host, 'mint-refused');
      }
      // Shown on every badge, filter and line: as the window may show it.
      const name = oneLine(status.json.name, 120);
      linked = { ...profile, serverId, ...(name ? { name } : {}), clientId, credential };
      saveProfile(deps.file, linked);
    } else if (linked.serverId === undefined) {
      linked = { ...linked, serverId };
      saveProfile(deps.file, linked);
    }

    // The profile's door path, else the host's path a Docker server says (TARS_DOOR_ON_HOST, M3 Task 6);
    // on Docker never the container's own path, which the host does not have.
    const onHost = typeof status.json.doorOnHost === 'string' && !remoteSocketProblem(status.json.doorOnHost) ? status.json.doorOnHost : undefined;
    const docker = linked.runner.kind === 'docker';
    const remoteSocket = linked.doorSocket ?? onHost ?? (!docker && typeof status.json.door === 'string' ? status.json.door : undefined);
    if (!remoteSocket) return failLink(id, host, docker ? 'no-door-on-host' : 'no-door');
    const failForward = (err: unknown) => {
      const problem = (err as { problem?: SshProblem }).problem ?? 'failed';
      set(id, { phase: 'failed', problem, sentence: (err as Error).message });
    };
    let forward: LinkForward;
    try {
      forward = await deps.forward(linked, remoteSocket);
    } catch (err) {
      return current() ? failForward(err) : undefined;
    }
    if (!current()) return forward.close();
    forwards.set(id, forward);
    try {
      await forward.ready;
    } catch (err) {
      if (forwards.get(id) === forward) closeForward(id);
      return current() ? failForward(err) : undefined;
    }
    if (!current()) return forward.close();
    const hello = await deps.client(forward.end).hello();
    if (!current()) return forward.close();
    if (!hello.ok || hello.serverId !== serverId) {
      closeForward(id);
      return failLink(id, host, hello.ok ? 'another-server' : 'no-door');
    }
    const upAt = now();
    void forward.ended.then(() => {
      if (forwards.get(id) !== forward) return;
      forwards.delete(id);
      if (now() - upAt >= RETRY_RESET_MS) tries.delete(id);
      const since = new Date(now()).toISOString();
      set(id, { phase: 'offline', since });
      retryLater(id, since);
    });
    set(id, { phase: 'connected', since: new Date(upAt).toISOString() });
  }

  return {
    connect(id) {
      cancelRetry(id);
      tries.delete(id);
      return attempt(id);
    },
    disconnect(id) {
      stop(id);
      set(id, { phase: 'off' });
    },
    refused(id) {
      stop(id);
      const host = find(id)?.host ?? 'the server';
      set(id, {
        phase: 'disconnected',
        since: new Date(now()).toISOString(),
        sentence: `The server on ${host} refused this computer's credential, which was probably revoked there. Forget this server here and connect again to get a new one.`,
      });
    },
    closeAll() {
      for (const id of new Set([...forwards.keys(), ...retries.keys(), ...connecting.keys()])) stop(id);
    },
    async forget(id) {
      stop(id);
      const profile = find(id);
      if (!profile) return set(id, { phase: 'off' });
      let problem: SshProblem | undefined;
      if (profile.clientId !== undefined) {
        const revoked = await deps.run(profile, { do: 'clients-revoke', id: profile.clientId });
        if (!revoked.ok) problem = revoked.problem;
      }
      forgetProfile(deps.file, id);
      if (!problem) return set(id, { phase: 'off' });
      set(id, {
        phase: 'off',
        problem,
        sentence: `Forgotten on this computer, but its credential still works on ${profile.host}: ${problemSentence(problem, profile.host)} Revoke ${profile.clientId} in the server's clients.`,
      });
    },
    end(id) {
      return states.get(id)?.phase === 'connected' ? forwards.get(id)?.end ?? null : null;
    },
    state(id) {
      return states.get(id) ?? { phase: 'off' };
    },
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
