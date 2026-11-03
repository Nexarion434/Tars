import { localForwardEnd } from '../platform/local-forward';
import { oneLine } from '../services/cloud/fleet-share';
import { createDoorClient, type DoorAnswer, type DoorClient, type DriveAction } from '../services/cloud-link/client';
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
  /** The direct test route (directRoute): a door socket reached with no ssh at all. */
  direct?: string | null;
}

/**
 * The E2E's way to a server with no SSH (plan Task 14): TARS_CLOUD_DIRECT
 * names a door's socket, and every saved server is reached there, its status
 * read from the door's hello and its forward the socket itself. Only an
 * unpackaged app reads it: a packaged Tars never does, whatever its
 * environment says.
 */
export function directRoute(env: NodeJS.ProcessEnv, packaged: boolean): string | null {
  const socket = env.TARS_CLOUD_DIRECT;
  if (!socket) return null;
  if (packaged) {
    console.warn('[cloud] TARS_CLOUD_DIRECT is for development runs only: ignored');
    return null;
  }
  return socket;
}

/** The link's `run` and `forward` over the direct route: hello stands for status, nothing else runs. */
function directDeps(socket: string, doorClient: (end: LocalEnd) => DoorClient): { run: typeof runServerCommand; forward: ForwardFactory } {
  const end: LocalEnd = { kind: 'unix', path: socket };
  return {
    run: async (_profile, command) => {
      if (command.do !== 'status') return { ok: false, problem: 'refused', detail: 'The direct test route runs no server command.' };
      const hello = await doorClient(end).hello();
      return hello.ok
        ? { ok: true, json: { running: true, serverId: hello.serverId, door: socket } }
        : { ok: false, problem: 'unreachable', detail: hello.detail };
    },
    forward: () => {
      let close!: () => void;
      const ended = new Promise<{ code: number | null; stderr: string }>(resolve => { close = () => resolve({ code: 0, stderr: '' }); });
      return { end, ready: Promise.resolve(), ended, close };
    },
  };
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

/** More than a client holds (see, drive, create, files). */
const MAX_SCOPES = 8;

/** One client of the server as the window shows it: named fields only, never a hash, each as a window may show it. */
function clientView(item: unknown): Array<Record<string, unknown>> {
  const source = (item ?? {}) as Record<string, unknown>;
  if (typeof source.id !== 'string' || !CLIENT_ID.test(source.id)) return [];
  const view: Record<string, unknown> = { id: source.id };
  for (const key of ['name', 'kind', 'createdAt', 'expiresAt', 'mintedVia']) {
    const shown = oneLine(source[key], 200);
    if (shown !== undefined) view[key] = shown;
  }
  view.scopes = (Array.isArray(source.scopes) ? source.scopes : []).slice(0, MAX_SCOPES).flatMap(s => oneLine(s, 20) ?? []);
  return [view];
}

export function registerCloudHandlers(deps: CloudHandlerDeps): CloudService {
  const doorClient = deps.doorClient ?? createDoorClient;
  const direct = deps.direct ? directDeps(deps.direct, doorClient) : null;
  const run = direct?.run ?? deps.run ?? runServerCommand;
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
    forward: direct?.forward ?? deps.forward ?? (async (profile, remoteSocket) => openForward(profile.host, await localForwardEnd(profile.id, { dir: deps.forwardDir }), remoteSocket)),
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
    // A stop is one click: the window asks no reason, and the server, which
    // needs one, is told which computer stopped it, by the name this
    // computer's client got when it was minted (link.ts).
    const clean = action === 'stop' ? { reason: `Stopped from ${deps.hostname().slice(0, 48)}` } : action === 'message' ? { text: given.text } : {};
    const result = await fleet.drive(remoteId, action as DriveAction, clean);
    if (result.success) void fleet.poll();
    return result;
  });
  ipc.handle('cloud:keys', (_e, remoteId, data) => (isRemoteId(remoteId) && typeof data === 'string' && data !== '' ? fleet.keys(remoteId, data) : NO_AGENT));
  ipc.handle('cloud:resize', (_e, remoteId, cols, rows) =>
    (isRemoteId(remoteId) && Number.isInteger(cols) && Number.isInteger(rows) ? fleet.resize(remoteId, cols as number, rows as number) : NO_AGENT));

  // M3 Task 7: creating on a server. The window's input narrowed to what the door takes, the door's answer
  // narrowed to what a window may show, and a device minted before `create` told how to get it.
  const doorOf = (id: unknown): { client: DoorClient } | { success: false; error: string } => {
    const profile = isProfileId(id) ? find(id) : undefined;
    if (!profile) return NO_SERVER;
    const end = link.end(profile.id);
    if (!end || !profile.credential) return fail(`${profile.name ?? profile.host} is not connected: connect it first.`);
    return { client: doorClient(end, profile.credential) };
  };
  const refusal = (answer: DoorAnswer) => (answer.status === 403
    ? fail('This computer may see and drive this server, not create on it: Forget this server, then Connect again to allow it.')
    : answer.status === 0
      ? fail('The server did not answer: the link dropped.')
      : fail(oneLine(answer.body.error, 300) ?? `The server answered ${answer.status}.`));
  const ok = (answer: DoorAnswer) => answer.status >= 200 && answer.status < 300;

  ipc.handle('cloud:createProject', async (_e, id, body) => {
    const door = doorOf(id);
    if (!('client' in door)) return door;
    const given = (body ?? {}) as { name?: unknown; from?: { kind?: unknown; url?: unknown; trusted?: unknown } };
    // A clone's trust in the repository's code goes on only as the window gave it, exactly true (security review 1, B1).
    const from = given.from?.kind === 'empty' ? { kind: 'empty' }
      : given.from?.kind === 'git' && typeof given.from.url === 'string' ? { kind: 'git', url: given.from.url, ...(given.from.trusted === true ? { trusted: true } : {}) } : null;
    if (typeof given.name !== 'string' || !from) return fail('A project is a name, made empty or from a git address.');
    const answer = await door.client.createProject({ name: given.name, from });
    // A name the server has, as the frame `Overlay · New project · where · name taken` says it.
    if (answer.status === 409) {
      const profile = find(id as string);
      return fail(`${profile?.name ?? profile?.host ?? 'This server'} already has a project called ${oneLine(given.name, 100) ?? ''}. Pick another name.`);
    }
    if (!ok(answer)) return refusal(answer);
    const project = (answer.body.project ?? {}) as Record<string, unknown>;
    return { success: true as const, project: { name: oneLine(project.name, 100) ?? given.name, path: oneLine(project.path, 400) ?? '' } };
  });
  ipc.handle('cloud:createAgent', async (_e, id, body) => {
    const door = doorOf(id);
    if (!('client' in door)) return door;
    const given = (body ?? {}) as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of ['projectName', 'projectPath', 'name', 'provider', 'model', 'effort', 'permissionMode', 'skills', 'character', 'start']) {
      if (given[key] !== undefined) fields[key] = given[key];
    }
    const answer = await door.client.createAgent(fields);
    if (!ok(answer)) return refusal(answer);
    void fleet.poll();
    const agent = (answer.body.agent ?? {}) as Record<string, unknown>;
    const startError = oneLine(answer.body.startError, 300);
    return {
      success: true as const,
      agent: { id: oneLine(agent.id, 64) ?? '', name: oneLine(agent.name, 120) ?? '' },
      started: answer.body.started === true,
      ...(startError ? { startError } : {}),
    };
  });
  ipc.handle('cloud:gitKey', async (_e, id) => {
    const door = doorOf(id);
    if (!('client' in door)) return door;
    const answer = await door.client.gitKey();
    if (!ok(answer)) return refusal(answer);
    return { success: true as const, publicKey: oneLine(answer.body.publicKey, 1000) ?? '', fingerprint: oneLine(answer.body.fingerprint, 100) ?? '' };
  });
  ipc.handle('cloud:projects', async (_e, id) => {
    const door = doorOf(id);
    if (!('client' in door)) return door;
    const answer = await door.client.fleet();
    if (!ok(answer)) return refusal(answer);
    const listed = Array.isArray(answer.body.projects) ? answer.body.projects.slice(0, 500) : [];
    const projects = listed.flatMap(item => {
      const p = (item ?? {}) as Record<string, unknown>;
      const name = oneLine(p.name, 100);
      const path = oneLine(p.path, 400);
      return typeof p.name === 'string' && typeof p.path === 'string' && name && path ? [{ name, path }] : [];
    });
    return { success: true as const, projects };
  });

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
