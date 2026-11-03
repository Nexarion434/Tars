import * as crypto from 'crypto';
import * as fs from 'fs';
import { writeSecretFileSync } from '../../utils/secret-file';
import { hostProblem, remoteSocketProblem, runnerProblem, type ServerRunner } from './ssh';

/**
 * The desktop's Tars servers (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 3),
 * in PRIVATE_DIR/cloud-link.json (0600, never handed to a CLI): how each is
 * reached and run, and once connected, its id and this desktop's credential
 * there. A file that does not parse reads as no server and is left as it is
 * until the user saves one. Every entry read passes the same checks as a save,
 * so what reaches `ssh` is what Task 1 accepts.
 */

export interface ServerProfile {
  id: string;
  /** `[user@]host` or an alias of the user's SSH config. */
  host: string;
  runner: ServerRunner;
  /** The door's socket on the SSH host. Required for a Docker runner: the container's `status` names its own path. */
  doorSocket?: string;
  /** Learned at the first connect; another one later is another server. */
  serverId?: string;
  name?: string;
  /** This desktop's client on the server, and its credential: both, or neither. */
  clientId?: string;
  credential?: string;
}

/** What the window may know of a profile: never the credential, never the door's socket path. */
export interface ServerView {
  id: string;
  host: string;
  runner: ServerRunner;
  serverId?: string;
  name?: string;
  clientId?: string;
  paired: boolean;
}

interface LinkFile { version: 1; servers: ServerProfile[] }

export const MAX_SERVERS = 16;
const PROFILE_ID = /^s_[0-9a-f]{8}$/;
const SERVER_ID = /^[0-9a-f]{16}$/;
const CLIENT_ID = /^c_[0-9a-f]{8}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 120;

export function newProfileId(): string {
  return `s_${crypto.randomBytes(4).toString('hex')}`;
}

function runnerShapeProblem(runner: unknown): string | null {
  const r = runner as Partial<Record<string, unknown>> | null;
  if (!r || typeof r !== 'object') return 'How the server runs is missing.';
  if (r.kind === 'command' && Array.isArray(r.argv) && r.argv.every(word => typeof word === 'string')) return null;
  if (r.kind === 'docker' && typeof r.container === 'string' && typeof r.sudo === 'boolean') return null;
  return 'How the server runs is not a command or a Docker container.';
}

/** Why `profile` cannot be kept or used, in words, or null when it can. */
export function profileProblem(profile: ServerProfile): string | null {
  if (!profile || typeof profile !== 'object') return 'Not a server profile.';
  if (typeof profile.id !== 'string' || !PROFILE_ID.test(profile.id)) return `${JSON.stringify(profile.id)} is not a server profile id.`;
  if (typeof profile.host !== 'string') return "The server's SSH host is missing.";
  const shape = runnerShapeProblem(profile.runner);
  if (shape) return shape;
  const problem = hostProblem(profile.host) ?? runnerProblem(profile.runner);
  if (problem) return problem;
  if (profile.doorSocket !== undefined) {
    const socket = typeof profile.doorSocket === 'string' ? remoteSocketProblem(profile.doorSocket) : 'The door socket path is not text.';
    if (socket) return socket;
  } else if (profile.runner.kind === 'docker') {
    return "Enter the path of the server's door socket on the host: inside a container, the server names its own path.";
  }
  if (profile.serverId !== undefined && (typeof profile.serverId !== 'string' || !SERVER_ID.test(profile.serverId))) return 'The server id is not one a Tars server makes.';
  if (profile.name !== undefined && (typeof profile.name !== 'string' || profile.name.length > NAME_MAX)) return 'The server name is too long.';
  const hasClient = profile.clientId !== undefined;
  if (hasClient !== (profile.credential !== undefined)) return 'A client id and its credential go together.';
  if (hasClient && (typeof profile.clientId !== 'string' || !CLIENT_ID.test(profile.clientId))) return 'The client id is not one a Tars server makes.';
  if (hasClient && (typeof profile.credential !== 'string' || !CREDENTIAL.test(profile.credential))) return 'The credential is not one a Tars server makes.';
  return null;
}

export type LinkRead = { servers: ServerProfile[]; problem?: string };

/** The servers in `file`; a missing file is none, and so is one that does not parse (said in `problem`). */
export function readLink(file: string): LinkRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [] };
    return { servers: [], problem: `${file}: ${(err as Error).message}` };
  }
  let parsed: Partial<LinkFile> | null;
  try {
    parsed = JSON.parse(raw) as Partial<LinkFile> | null;
  } catch (err) {
    return { servers: [], problem: `${file}: ${(err as Error).message}` };
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.servers)) return { servers: [], problem: `${file}: not a cloud link file` };
  const servers = parsed.servers.filter(server => profileProblem(server) === null).slice(0, MAX_SERVERS);
  return servers.length === parsed.servers.length ? { servers } : { servers, problem: `${file}: ${parsed.servers.length - servers.length} server(s) set aside, they fail the checks` };
}

function write(file: string, servers: ServerProfile[]): void {
  writeSecretFileSync(file, `${JSON.stringify({ version: 1, servers } satisfies LinkFile, null, 2)}\n`);
}

/** Adds `profile`, or replaces the one with its id. Throws, writing nothing, when it fails the checks. */
export function saveProfile(file: string, profile: ServerProfile): void {
  const problem = profileProblem(profile);
  if (problem) throw new Error(problem);
  const servers = readLink(file).servers;
  const at = servers.findIndex(server => server.id === profile.id);
  if (at >= 0) servers[at] = profile;
  else if (servers.length >= MAX_SERVERS) throw new Error(`Tars keeps ${MAX_SERVERS} servers at most.`);
  else servers.push(profile);
  write(file, servers);
}

/** Removes the profile `id`; false when there was none. */
export function forgetProfile(file: string, id: string): boolean {
  const servers = readLink(file).servers;
  const kept = servers.filter(server => server.id !== id);
  if (kept.length === servers.length) return false;
  write(file, kept);
  return true;
}

export function publicView(profile: ServerProfile): ServerView {
  const runner: ServerRunner = profile.runner.kind === 'docker'
    ? { kind: 'docker', container: profile.runner.container, sudo: profile.runner.sudo }
    : { kind: 'command', argv: [...profile.runner.argv] };
  const view: ServerView = { id: profile.id, host: profile.host, runner, paired: profile.credential !== undefined };
  if (profile.serverId !== undefined) view.serverId = profile.serverId;
  if (profile.name !== undefined) view.name = profile.name;
  if (profile.clientId !== undefined) view.clientId = profile.clientId;
  return view;
}
