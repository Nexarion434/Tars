import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PRIVATE_DIR } from '../../constants';

/**
 * The Tars server's own Git access (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 2b, Nicolas's decision 2): private repositories are cloned with an SSH
 * key made on the server, which never leaves it, and never with anything of a
 * desktop's. Its public half is what Nicolas adds to GitHub.
 *
 * The git hosts' keys are pinned, never accepted blind: known_hosts here
 * holds GitHub's published keys (`gh api meta`, 2026-11-03, their
 * fingerprints pinned in git-access.test.ts), and any other host only once the
 * operator adds its line (addKnownHost), its fingerprint printed back to
 * compare with the one the host publishes. ssh, as git runs it, reads no
 * config but its options, no known hosts but that file, adds or updates no
 * key and forwards nothing.
 */

export const GITHUB_HOST_KEYS: readonly string[] = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
];

/** Runs ssh-keygen with these arguments (a test's, in tests). */
export type Keygen = (args: string[]) => Promise<void>;

export interface GitAccessDeps {
  /** Where the key and known_hosts live: ~/.tars-private/git. */
  dir?: string;
  keygen?: Keygen;
  /** Named in the key's comment, so GitHub's list says which server it is. */
  serverId?: string;
}

const KEY = 'id_ed25519';
const KNOWN = 'known_hosts';
const dirOf = (deps: GitAccessDeps) => deps.dir ?? path.join(PRIVATE_DIR, 'git');

const TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\]:\d{1,5})$/;

/** The key's own type, as its blob starts: a length, then the name. */
const blobType = (blob: Buffer): string | null => {
  if (blob.length < 4) return null;
  const n = blob.readUInt32BE(0);
  return n > 0 && n < 64 && blob.length >= 4 + n ? blob.subarray(4, 4 + n).toString('latin1') : null;
};

/** ssh-keygen's SHA256 fingerprint of a public key line (`[host] <type> <base64> [comment]`), or null. */
export function keyFingerprint(line: string): string | null {
  const words = line.trim().split(/\s+/);
  const at = words.findIndex(w => TYPES.has(w));
  if (at < 0 || !words[at + 1] || !BASE64.test(words[at + 1])) return null;
  const blob = Buffer.from(words[at + 1], 'base64');
  if (blobType(blob) !== words[at]) return null;
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Why ssh would read this known_hosts line wider than one host and one key, or null. */
export function knownHostProblem(line: string): string | null {
  const words = line.trim().split(/\s+/);
  if (words.length !== 3 || words[0] === '') return 'A known host is one line: <host> <type> <key>, nothing more.';
  const [host, type, key] = words;
  if (!HOST.test(host)) return `"${host.slice(0, 80)}" is not one host: no wildcard, list, negation, hashed name or marker.`;
  if (!TYPES.has(type)) return `"${type.slice(0, 40)}" is not a key type Tars takes.`;
  if (!BASE64.test(key) || blobType(Buffer.from(key, 'base64')) !== type) return 'The key is not a key of that type.';
  return null;
}

const isLink = (p: string): boolean => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** The folder, 0700, never a link. */
function ensureDir(dir: string): string | null {
  if (isLink(dir)) return `${dir} is a link: Tars keeps its Git key in a plain folder.`;
  if (!exists(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return null;
}

const defaultKeygen: Keygen = args => new Promise((resolve, reject) => {
  execFile('ssh-keygen', args, { timeout: 30_000, windowsHide: true }, err => (err ? reject(err) : resolve()));
});

/**
 * The server's public key, made on first need with ssh-keygen (ed25519, no
 * passphrase: nobody is there to type one), never over an existing key, never
 * through a link. Only the public half is read.
 */
export async function gitKey(deps: GitAccessDeps = {}): Promise<{ ok: true; publicKey: string; fingerprint: string } | { ok: false; error: string }> {
  const dir = dirOf(deps);
  const dirWrong = ensureDir(dir);
  if (dirWrong) return { ok: false, error: dirWrong };
  const key = path.join(dir, KEY);
  const pub = `${key}.pub`;
  if (isLink(key) || isLink(pub)) return { ok: false, error: 'The server\'s Git key is a link: Tars leaves it and makes none.' };
  if (exists(key) && !exists(pub)) return { ok: false, error: `${key} has no public half (${KEY}.pub): Tars leaves it as it is and makes no other.` };
  if (!exists(key)) {
    if (exists(pub)) return { ok: false, error: `${pub} has no private half: Tars leaves it as it is.` };
    try {
      await (deps.keygen ?? defaultKeygen)(['-q', '-t', 'ed25519', '-N', '', '-C', `tars-server ${deps.serverId ?? os.hostname()}`, '-f', key]);
    } catch (err) {
      return { ok: false, error: `ssh-keygen could not make the server's Git key: ${(err as Error).message}` };
    }
  }
  if (process.platform !== 'win32' && (fs.statSync(key).mode & 0o077) !== 0) {
    return { ok: false, error: `${key} is a key others can read: Tars uses it only once it is 0600.` };
  }
  const publicKey = fs.readFileSync(pub, 'utf8').trim();
  const fingerprint = keyFingerprint(publicKey);
  if (!fingerprint) return { ok: false, error: `${pub} is not a public key Tars can read.` };
  return { ok: true, publicKey, fingerprint };
}

/** known_hosts with every pinned line in it, the operator's own kept. */
export function ensureKnownHosts(deps: GitAccessDeps = {}): { ok: true } | { ok: false; error: string } {
  const dir = dirOf(deps);
  const dirWrong = ensureDir(dir);
  if (dirWrong) return { ok: false, error: dirWrong };
  const file = path.join(dir, KNOWN);
  if (isLink(file)) return { ok: false, error: `${file} is a link: Tars writes its known hosts in a plain file.` };
  const lines = exists(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  const missing = GITHUB_HOST_KEYS.filter(l => !lines.includes(l));
  if (missing.length > 0 || !exists(file)) fs.writeFileSync(file, `${[...lines, ...missing].join('\n')}\n`, { mode: 0o600 });
  return { ok: true };
}

/** An operator's known host, one host and one key, appended; its fingerprint said back. */
export function addKnownHost(line: string, deps: GitAccessDeps = {}): { ok: true; fingerprint: string } | { ok: false; error: string } {
  const wrong = knownHostProblem(line);
  if (wrong) return { ok: false, error: wrong };
  const ready = ensureKnownHosts(deps);
  if (!ready.ok) return ready;
  const clean = line.trim().split(/\s+/).join(' ');
  fs.appendFileSync(path.join(dirOf(deps), KNOWN), `${clean}\n`);
  return { ok: true, fingerprint: keyFingerprint(clean)! };
}

/** A path for the shell git runs core.sshCommand through. */
const shellQuoted = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

/** core.sshCommand for a clone over SSH: the server's key, the pinned hosts, nothing else. */
export function gitSshCommand(deps: GitAccessDeps = {}): string {
  const dir = dirOf(deps);
  const join = (name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`;
  return [
    'ssh', '-F', 'none', '-i', shellQuoted(join(KEY)),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${shellQuoted(join(KNOWN))}`, '-o', `GlobalKnownHostsFile=${os.devNull}`,
    '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no',
  ].join(' ');
}

/** What a failed clone over SSH means for a person, or null when it is not about keys. */
export function gitSshProblem(stderr: string, host: string): string | null {
  if (/Host key verification failed|host key is known for|No \S+ host key is known/i.test(stderr)) {
    return `This server does not know ${host}'s key. Add its line with the server's CLI (git known-host add), after checking its fingerprint.`;
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/i.test(stderr)) {
    return `${host} shows another key than the one this server knows: the clone was stopped.`;
  }
  if (/Permission denied \(publickey/i.test(stderr)) {
    return `The server's Git key is not allowed on ${host}. Add its public key (git key) to the repository or to the account, then try again.`;
  }
  return null;
}
