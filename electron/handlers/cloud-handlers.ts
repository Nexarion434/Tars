import { localForwardEnd } from '../platform/local-forward';
import { createDoorClient, type DoorClient, type DriveAction } from '../services/cloud-link/client';
import { openForward } from '../services/cloud-link/forward';
import { createCloudLink, type ForwardFactory } from '../services/cloud-link/link';
import { createRemoteFleet, parseCloudId } from '../services/cloud-link/remote-fleet';
import { problemSentence, runServerCommand } from '../services/cloud-link/remote-run';
import type { LocalEnd, ServerRunner } from '../services/cloud-link/ssh';
import { newProfileId, publicView, readLink, saveProfile, type ServerProfile } from '../services/cloud-link/store';

/**
 * window.electronAPI.cloud (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 9):
 * Settings > Cloud's servers and their link, and a server's agents in the
 * window. Main holds every state. Nothing that reaches the window carries a
 * credential, the door's socket path or a host key: profiles go through
 * publicView, clients through the fields named below. An id of another shape
 * is refused before the link, the fleet or `ssh` sees it. With no server in
 * cloud-link.json nothing runs: no `ssh`, no timer.
 */

export interface CloudHandlerDeps {
  ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
  broadcast(channel: string, payload: unknown): void;
  /** cloud-link.json, in PRIVATE_DIR. */
  file: string;
  /** Where the forwards' Unix sockets live (PRIVATE_DIR/cloud); unused on Windows. */
  forwardDir: string;
  hostname(): string;
  run?: typeof runServerCommand;
  forward?: ForwardFactory;
  doorClient?: (end: LocalEnd, credential?: string) => DoorClient;
  /** Runs `fn` every `ms` until the stop it returns: the fleet's poll while a server is connected. */
  every?: (fn: () => void, ms: number) => () => void;
  fleetEveryMs?: number;
}

export interface CloudService {
  /** Connects the servers this desktop holds a credential for. */
  start(): Promise<void>;
  pollNow(): Promise<void>;
  /** The quit: every local `ssh` ends, nothing is sent to a server. */
  stop(): void;
}

const PROFILE_ID = /^s_[0-9a-f]{8}$/;
const CLIENT_ID = /^c_[0-9a-f]{8}$/;
/** What the window drives by name; keys and size have their own calls. */
const ACTIONS = new Set(['start', 'stop', 'message']);
const NO_SERVER = { success: false as const, error: 'There is no such server.' };
const NO_AGENT = { success: false as const, error: 'There is no such agent.' };
const fail = (err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) });

const isProfileId = (id: unknown): id is string => typeof id === 'string' && PROFILE_ID.test(id);
const isRemoteId = (id: unknown): id is string => typeof id === 'string' && parseCloudId(id) !== null;

/** A runner as the window typed it, rebuilt field by field (store.ts checks the words). */
function runnerOf(input: unknown): ServerRunner {
  const runner = (input ?? {}) as Record<string, unknown>;
  if (runner.kind === 'docker') return { kind: 'docker', container: String(runner.container ?? ''), sudo: runner.sudo === true };
  return { kind: 'command', argv: Array.isArray(runner.argv) ? runner.argv.map(String) : [] };
}

/** One client of the server as the window shows it: named fields only, never a hash. */
function clientView(item: unknown): Array<Record<string, unknown>> {
  const source = (item ?? {}) as Record<string, unknown>;
  if (typeof source.id !== 'string' || !CLIENT_ID.test(source.id)) return [];
  const view: Record<string, unknown> = { id: source.id };
  for (const key of ['name', 'kind', 'createdAt', 'expiresAt', 'mintedVia']) {
    if (typeof source[key] === 'string') view[key] = (source[key] as string).slice(0, 200);
  }
  view.scopes = Array.isArray(source.scopes) ? source.scopes.filter(s => typeof s === 'string') : [];
  return [view];
}

export function registerCloudHandlers(deps: CloudHandlerDeps): CloudService {
  const run = deps.run ?? runServerCommand;
  const doorClient = deps.doorClient ?? createDoorClient;
  const every = deps.every ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  const servers = () => readLink(deps.file).servers;
  const find = (id: string) => servers().find(server => server.id === id);

  const link = createCloudLink({
    file: deps.file,
    run,
    hostname: deps.hostname,
    forward: deps.forward ?? (async (profile, remoteSocket) => openForward(profile.host, await localForwardEnd(profile.id, { dir: deps.forwardDir }), remoteSocket)),
    client: end => doorClient(end),
  });

  const fleet = createRemoteFleet({
    servers: () => servers().flatMap(s => (s.serverId ? [{ id: s.id, serverId: s.serverId, name: s.name ?? s.host }] : [])),
    link: server => {
      const end = link.end(server.id);
      const credential = find(server.id)?.credential;
      return end && credential ? { client: doorClient(end, credential) } : { phase: link.state(server.id).phase };
    },
    refused: id => link.refused(id),
    onFleet: agents => deps.broadcast('cloud:agents', agents),
    onOutput: (remoteId, data) => deps.broadcast('cloud:output', { remoteId, data }),
  });

  let stopPolling: (() => void) | null = null;
  link.onState((id, state) => {
    deps.broadcast('cloud:state', { id, state });
    if (state.phase === 'connected' && !stopPolling) stopPolling = every(() => { void fleet.poll(); }, deps.fleetEveryMs ?? 3_000);
    if (stopPolling && !servers().some(s => link.state(s.id).phase === 'connected')) {
      stopPolling();
      stopPolling = null;
    }
    void fleet.poll();
  });

  function save(input: unknown) {
    if (!input || typeof input !== 'object') return fail('Not a server.');
    const { id, host, runner, doorSocket } = input as Record<string, unknown>;
    const existing = isProfileId(id) ? find(id) : undefined;
    if (id !== undefined && !existing) return NO_SERVER;
    if (existing && existing.host !== host) return fail('A server keeps its host: forget it here, then add the new host as a server of its own.');
    const profile: ServerProfile = { ...existing, id: existing?.id ?? newProfileId(), host: String(host ?? ''), runner: runnerOf(runner) };
    delete profile.doorSocket;
    if (typeof doorSocket === 'string' && doorSocket !== '') profile.doorSocket = doorSocket;
    try {
      saveProfile(deps.file, profile);
    } catch (err) {
      return fail(err);
    }
    return { success: true as const, id: profile.id };
  }

  const { ipc } = deps;
  ipc.handle('cloud:list', () => servers().map(s => ({ ...publicView(s), state: link.state(s.id) })));
  ipc.handle('cloud:save', (_e, input) => save(input));
  ipc.handle('cloud:connect', async (_e, id) => {
    if (!isProfileId(id)) return NO_SERVER;
    await link.connect(id);
    return { success: true, state: link.state(id) };
  });
  ipc.handle('cloud:disconnect', (_e, id) => {
    if (!isProfileId(id)) return NO_SERVER;
    link.disconnect(id);
    return { success: true };
  });
  ipc.handle('cloud:forget', async (_e, id) => {
    if (!isProfileId(id)) return NO_SERVER;
    await link.forget(id);
    void fleet.poll();
    return { success: true, state: link.state(id) };
  });
  ipc.handle('cloud:clients', async (_e, id) => {
    const profile = isProfileId(id) ? find(id) : undefined;
    if (!profile) return NO_SERVER;
    const answer = await run(profile, { do: 'clients-list' });
    if (!answer.ok) return { success: false, error: problemSentence(answer.problem, profile.host) };
    return { success: true, clients: (Array.isArray(answer.json.clients) ? answer.json.clients : []).flatMap(clientView) };
  });
  ipc.handle('cloud:revoke', async (_e, id, clientId) => {
    const profile = isProfileId(id) ? find(id) : undefined;
    if (!profile) return NO_SERVER;
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return fail('Not a client id of a Tars server.');
    const answer = await run(profile, { do: 'clients-revoke', id: clientId });
    return answer.ok ? { success: true } : { success: false, error: problemSentence(answer.problem, profile.host) };
  });

  ipc.handle('cloud:agents', () => fleet.list());
  ipc.handle('cloud:screen', (_e, remoteId) => (isRemoteId(remoteId) ? fleet.screen(remoteId) : null));
  ipc.handle('cloud:watch', (_e, remoteId) => { if (isRemoteId(remoteId)) fleet.watch(remoteId); });
  ipc.handle('cloud:unwatch', (_e, remoteId) => { if (isRemoteId(remoteId)) fleet.unwatch(remoteId); });
  ipc.handle('cloud:drive', async (_e, remoteId, action, body) => {
    if (!isRemoteId(remoteId) || typeof action !== 'string' || !ACTIONS.has(action)) return NO_AGENT;
    const given = (body ?? {}) as Record<string, unknown>;
    const clean = action === 'stop' ? { reason: given.reason } : action === 'message' ? { text: given.text } : {};
    const result = await fleet.drive(remoteId, action as DriveAction, clean);
    if (result.success) void fleet.poll();
    return result;
  });
  ipc.handle('cloud:keys', (_e, remoteId, data) => (isRemoteId(remoteId) && typeof data === 'string' && data !== '' ? fleet.keys(remoteId, data) : NO_AGENT));
  ipc.handle('cloud:resize', (_e, remoteId, cols, rows) =>
    (isRemoteId(remoteId) && Number.isInteger(cols) && Number.isInteger(rows) ? fleet.resize(remoteId, cols as number, rows as number) : NO_AGENT));

  return {
    async start() {
      await Promise.all(servers().filter(s => s.credential !== undefined).map(s => link.connect(s.id)));
    },
    pollNow: () => fleet.poll(),
    stop() {
      stopPolling?.();
      stopPolling = null;
      fleet.stop();
      link.closeAll();
    },
  };
}
