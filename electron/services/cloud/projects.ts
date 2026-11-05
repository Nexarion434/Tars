import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isUnsafePathSegment } from '../../platform/windows-names';
import { isUnder } from '../../platform/path-compare';
import { safeGit } from '../../utils/safe-git';
import { ensureKnownHosts, gitKey, gitSshCommand, gitSshProblem, type GitAccessDeps } from './git-access';

/**
 * A project made on a Tars server, empty or cloned
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 2), for the door's
 * POST /cloud/v1/projects and the server's CLI.
 *
 * Projects live in ~/projects (Nicolas's decision 1). A name is one plain
 * path segment, checked by the Windows rules too, so that a project can move
 * to any desktop later. A git address is one of three shapes (decision 2):
 * https://host/owner/repo, git@host:owner/repo, ssh://git@host/owner/repo,
 * never with a credential in it: the server signs in with its own key. git
 * runs through safeGit (no program of the repository's, https and ssh only,
 * no prompt), by execFile, the address after `--`, one commit deep and
 * without submodules. Nothing existing is replaced; a clone that fails, runs
 * out of time or grows past its cap leaves no folder behind.
 */

/**
 * A clone carries the user's word that they trust the repository's code, and
 * who gave it (security review 1, B1): Tars trusts an agent's folder for its
 * CLI before it starts, so a cloned repository's own settings and hooks run
 * on the server at the first start, before any prompt, in any permission mode.
 */
export type ProjectFrom = { kind: 'empty' } | { kind: 'git'; url: string; trusted: true; by: string };
export type ProjectResult = { ok: true; path: string } | { ok: false; status: 400 | 409 | 500 | 502 | 504 | 507; error: string };

/** What runs git: safeGit, or a test's. */
export type GitRunner = (cwd: string, args: string[], opts: { timeout: number; signal: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

export interface ProjectDeps {
  root?: string;
  git?: GitRunner;
  /** A clone's time, 10 min by default. */
  timeoutMs?: number;
  /** A clone's size, 2 GB by default. */
  maxBytes?: number;
  /** How often a clone's size is read, 2 s by default. */
  pollMs?: number;
  /** The server's own Git key and pinned hosts, for a clone over SSH (git-access.ts). */
  gitAccess?: GitAccessDeps;
  /** Where each trusted clone is recorded: ~/.tars-private/project-trust.json by default. */
  trustFile?: string;
  now?: () => Date;
}

export const UNTRUSTED = 'A repository is cloned only once you trust its code: its settings can run code on this server as soon as an agent starts in it. Tick "I trust this repository\'s code" if you do.';

/** One line per trusted clone, kept beside the server's other private records (0600). */
function recordTrust(file: string, entry: { path: string; url: string; by: string; at: string }): void {
  let list: unknown[] = [];
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) list = parsed; } catch { /* first one */ }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...list, entry], null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The host a git address names: for git's own words about keys. */
const gitHost = (url: string): string => (url.startsWith('https://') || url.startsWith('ssh://') ? new URL(url).hostname : url.slice(url.indexOf('@') + 1, url.indexOf(':')));

export const projectsRoot = (home: string = os.homedir()): string => path.join(home, 'projects');

const NAME = /^[A-Za-z0-9._ -]{1,100}$/;

export function projectNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return 'Give the project a name.';
  if (!NAME.test(name) || name !== name.trim()) {
    return 'A project name is letters, digits, spaces, dots, dashes and underscores, up to 100, with no space at either end.';
  }
  if (name === '.' || name === '..' || name.startsWith('.') || name.startsWith('-')) return 'A project name cannot start with a dot or a dash.';
  // The Windows rules everywhere: a name a desktop could not hold (NUL, a trailing dot).
  if (isUnsafePathSegment(name, 'win32')) return `"${name}" is a name Windows keeps for itself, or ends with a dot or a space.`;
  return null;
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SHAPES = 'Tars clones https://host/owner/repo, git@host:owner/repo or ssh://git@host/owner/repo, and nothing else.';
const CREDENTIAL = 'This address carries a name or password: give the address alone. The server signs in with its own key.';

/** The repository's path: two segments at least, each plain, never `.` or `..`. */
const pathProblem = (p: string): string | null => {
  const segments = p.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  return segments.length >= 2 && segments.every(s => SEGMENT.test(s) && s !== '..' && s !== '.') ? null : SHAPES;
};

export function gitUrlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return 'Give the repository\'s address.';
  if (url.length > 2048) return 'This address is too long.';
  // No whitespace, no control character, no percent (an escape could spell `..`), never an option.
  if (/[\s\u0000-\u001f\u007f%]/.test(url) || url.startsWith('-')) return SHAPES;

  if (url.startsWith('https://') || url.startsWith('ssh://')) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return SHAPES; }
    const ssh = parsed.protocol === 'ssh:';
    if (parsed.password || (ssh ? parsed.username !== 'git' : parsed.username !== '')) return CREDENTIAL;
    if (parsed.port !== '' && parsed.port !== (ssh ? '22' : '443')) return SHAPES;
    if (!HOST.test(parsed.hostname) || parsed.search || parsed.hash) return SHAPES;
    return pathProblem(parsed.pathname);
  }

  const scp = /^([^@:/]+)@([^:/]+):(.+)$/.exec(url);
  if (scp) {
    if (scp[1] !== 'git') return CREDENTIAL;
    if (!HOST.test(scp[2])) return SHAPES;
    return pathProblem(scp[3]);
  }
  return SHAPES;
}

/** The bytes under a folder, links not followed, stopping as soon as `cap` is passed. */
function bytesOver(dir: string, cap: number): boolean {
  let total = 0;
  const walk = (d: string): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.isFile()) {
        try { total += fs.lstatSync(p).size; } catch { /* gone meanwhile */ }
        if (total > cap) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

const defaultGit: GitRunner = (cwd, args, opts) => safeGit(cwd, args, { timeout: opts.timeout, signal: opts.signal, maxBuffer: 1024 * 1024 });

/** The last line git said, for a person: no more than 200 characters. */
const lastLine = (err: unknown): string => {
  const said = String((err as { stderr?: unknown }).stderr ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return (said[said.length - 1] ?? (err as Error).message ?? 'git failed').slice(0, 200);
};

export async function createProject(name: string, from: ProjectFrom, deps: ProjectDeps = {}): Promise<ProjectResult> {
  const nameWrong = projectNameProblem(name);
  if (nameWrong) return { ok: false, status: 400, error: nameWrong };
  if (from.kind === 'git') {
    const urlWrong = gitUrlProblem(from.url);
    if (urlWrong) return { ok: false, status: 400, error: urlWrong };
    if (from.trusted !== true || typeof from.by !== 'string' || from.by === '') return { ok: false, status: 400, error: UNTRUSTED };
  } else if (from.kind !== 'empty') {
    return { ok: false, status: 400, error: 'A project is made empty or from a git address.' };
  }

  const root = deps.root ?? projectsRoot();
  // The projects folder: made when missing, used only when it is a plain folder.
  let rootStat: fs.Stats | undefined;
  try { rootStat = fs.lstatSync(root); } catch { /* missing */ }
  if (!rootStat) {
    try { fs.mkdirSync(root, { mode: 0o700 }); } catch (err) {
      return { ok: false, status: 500, error: `Tars could not make the projects folder ${root}: ${(err as Error).message}` };
    }
  } else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { ok: false, status: 500, error: `The projects folder on this server, ${root}, is not a plain folder: Tars leaves it as it is.` };
  }

  const target = path.join(root, name);
  // The name was checked; this holds whatever a later change to the checks lets through.
  if (!isUnder(target, root)) return { ok: false, status: 400, error: 'This name would leave the projects folder.' };
  // The folder reserved at once, before anything awaits (security review 1, N4): a second request for the
  // name is refused here, so a cleanup below only ever removes this call's own folder. mkdir fails on
  // anything there, a dangling link included; git clones into an empty folder.
  try { fs.mkdirSync(target); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, status: 409, error: `A project named "${name}" is already on this server.` };
    return { ok: false, status: 500, error: `Tars could not make the folder ${target}: ${(err as Error).message}` };
  }

  const git = deps.git ?? defaultGit;
  const timeout = deps.timeoutMs ?? 10 * 60_000;
  const abort = new AbortController();
  const removeTarget = () => fs.rmSync(target, { recursive: true, force: true });

  if (from.kind === 'empty') {
    try {
      await git(target, ['init', '--quiet'], { timeout: 60_000, signal: abort.signal });
      return { ok: true, path: target };
    } catch (err) {
      removeTarget();
      return { ok: false, status: 500, error: `git could not start the project: ${lastLine(err)}` };
    }
  }

  // Over SSH: the server's own key and the pinned hosts, both there before git runs (Task 2b).
  const overSsh = !from.url.startsWith('https://');
  let sshOptions: string[] = [];
  if (overSsh) {
    const key = await gitKey(deps.gitAccess);
    if (!key.ok) { removeTarget(); return { ok: false, status: 500, error: key.error }; }
    const hosts = ensureKnownHosts(deps.gitAccess);
    if (!hosts.ok) { removeTarget(); return { ok: false, status: 500, error: hosts.error }; }
    // After safeGit's own core.sshCommand=ssh: the last -c wins.
    sshOptions = ['-c', `core.sshCommand=${gitSshCommand(deps.gitAccess)}`];
  }

  const cap = deps.maxBytes ?? 2 * 1024 ** 3;
  let tooBig = false;
  const watch = setInterval(() => {
    if (!tooBig && bytesOver(target, cap)) { tooBig = true; abort.abort(); }
  }, deps.pollMs ?? 2000);
  try {
    await git(root, [...sshOptions, 'clone', '--no-recurse-submodules', '--depth', '1', '--', from.url, name], { timeout, signal: abort.signal });
    clearInterval(watch);
    if (tooBig || bytesOver(target, cap)) {
      removeTarget();
      return { ok: false, status: 507, error: `The repository is larger than ${Math.round(cap / 1024 ** 2)} MB: not kept.` };
    }
    try {
      recordTrust(deps.trustFile ?? path.join(os.homedir(), '.tars-private', 'project-trust.json'),
        { path: target, url: from.url, by: from.by.slice(0, 80), at: (deps.now ?? (() => new Date()))().toISOString() });
    } catch (err) {
      removeTarget();
      return { ok: false, status: 500, error: `Tars could not record that you trust this repository, so it is not kept: ${(err as Error).message}` };
    }
    return { ok: true, path: target };
  } catch (err) {
    clearInterval(watch);
    removeTarget();
    if (tooBig) return { ok: false, status: 507, error: `The repository is larger than ${Math.round(cap / 1024 ** 2)} MB: the clone was stopped.` };
    const e = err as { killed?: boolean; code?: unknown };
    if (e.killed || e.code === 'ETIMEDOUT') return { ok: false, status: 504, error: `git took longer than ${Math.round(timeout / 60_000) || 1} min to clone it: stopped.` };
    const keys = overSsh ? gitSshProblem(String((err as { stderr?: unknown }).stderr ?? ''), gitHost(from.url)) : null;
    return { ok: false, status: 502, error: keys ?? `git could not clone it: ${lastLine(err)}` };
  }
}

/** The server's projects: the plain folders under the projects folder, by name. */
export function listProjects(root: string = projectsRoot()): Array<{ name: string; path: string }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
