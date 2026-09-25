import {
  execFile, execFileSync, type ExecFileOptionsWithStringEncoding, type ExecFileSyncOptionsWithStringEncoding,
} from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  envValue, getPath, pathEntries, realFs, resolveCliBinary, withPath,
  type CliBinaryFailure, type Env, type FsProbe,
} from '../platform';
import { unquoteEntry } from '../platform/path-env';
import { buildFullPath } from '../utils/path-builder';

/**
 * How Tars runs a CLI outside an agent's PTY, and finds one on Windows
 * (audit A11, A18, A24, B/C-01..C-05, B/M-01).
 *
 * Registering an MCP server (`claude mcp add`, `codex mcp add`, ...), asking
 * `claude mcp list`, the kanban's one-shot `claude -p`, `gws auth status`:
 * each used to hand a bare name to execFile, or a whole line to a shell. On
 * Windows the bare name finds only a .exe (libuv skips PATHEXT), so every npm
 * install (claude.cmd, codex.cmd) was ENOENT and the error was swallowed; and
 * a line handed to cmd.exe is split and expanded. Here the name goes through
 * the platform layer's resolveCliBinary and the CLI is started with execFile
 * and an argv: `file` is a .exe or node.exe, and an npm shim's script goes in
 * front of the arguments. darwin and linux get the name as given and the
 * options as given, which is what execFile got before, byte for byte.
 *
 * Candidates for electron/platform, which this lot may not edit: see the
 * lot's report.
 */

/** Why a CLI cannot be started: the resolver's answer, kept whole for the log. */
export class CliNotRunnableError extends Error {
  readonly failure: CliBinaryFailure;
  constructor(failure: CliBinaryFailure) {
    super(`${failure.name} cannot be started (${failure.reason}): ${failure.detail}`);
    this.name = 'CliNotRunnableError';
    this.failure = failure;
  }
}

/** The file to start for `name` and the argv it gets. Throws CliNotRunnableError. */
export function cliInvocation(
  name: string, args: readonly string[], env: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { file: string; args: string[] } {
  const binary = resolveCliBinary(name, env, platform, fs);
  if (!binary.ok) throw new CliNotRunnableError(binary);
  return { file: binary.file, args: [...binary.prefixArgs, ...args] };
}

/**
 * The environment a CLI is looked up in and started with when the caller
 * gives none. darwin/linux: none, so child_process reads process.env as it
 * always did. win32: process.env with the PATH an agent's PTY gets
 * (buildFullPath: %USERPROFILE%\.local\bin and %APPDATA%\npm appended), under
 * one key, so the CLI found is the one an agent would run and the child reads
 * that same PATH.
 */
export function cliEnv(platform: NodeJS.Platform = process.platform, env: Env = process.env): Env | undefined {
  if (platform !== 'win32') return undefined;
  return withPath(env, buildFullPath([], { env: env as NodeJS.ProcessEnv, platform }), platform);
}

function prepare<O extends { env?: NodeJS.ProcessEnv }>(name: string, args: readonly string[], options: O) {
  const platform = process.platform;
  const env = options.env ?? (cliEnv(platform) as NodeJS.ProcessEnv | undefined);
  const invocation = cliInvocation(name, args, env ?? process.env, platform);
  return { ...invocation, options: env === options.env ? options : { ...options, env } };
}

/** execFileSync for a CLI named or configured by the user. Throws CliNotRunnableError before any spawn. */
export function execCliSync(name: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string {
  const run = prepare(name, args, options);
  return execFileSync(run.file, run.args, run.options);
}

/** execFile (promisified) for a CLI. Rejects with CliNotRunnableError before any spawn. */
export async function execCli(
  name: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  const run = prepare(name, args, options);
  // Promisified here, not at load: a module that only needs the sync path
  // (the providers) does not need execFile to exist.
  return promisify(execFile)(run.file, run.args, run.options);
}

/** One line for a log: the resolver's reason, or the first line of the spawn error. */
export function cliFailureText(err: unknown): string {
  if (err instanceof CliNotRunnableError) return err.message;
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0];
}

/**
 * The command and args to write into a CLI's MCP config for a stdio server,
 * which that CLI starts later with its own spawn. win32: an npm shim (`npx`,
 * a gws.cmd) cannot be started that way, so it becomes node (or the shim's
 * .exe) with the script in front of the args. Node is written as bare `node`
 * whenever the node the shim would run is the one the PATH finds, and a real
 * .exe the PATH finds (`node`) stays as named: the absolute path of today's
 * node.exe dies at the next nvm or fnm switch, and isMcpServerRegistered,
 * which compares the script, would never rewrite it. Only a node.exe beside
 * the shim that the PATH does not give keeps its full path. A command that
 * cannot be resolved is kept as given and the reason handed back, for the
 * caller to log. darwin/linux: as given.
 */
export function stdioServerCommand(
  command: string, args: string[], env?: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { command: string; args: string[]; unresolved?: CliBinaryFailure } {
  const lookupEnv = env ?? cliEnv(platform) ?? process.env;
  const binary = resolveCliBinary(command, lookupEnv, platform, fs);
  if (!binary.ok) return { command, args, unresolved: binary };
  if (binary.via === 'as-given' || binary.via === 'exe') return { command, args };
  const withScript = [...binary.prefixArgs, ...args];
  if (binary.via === 'npm-shim-node') {
    const pathNode = resolveCliBinary('node', lookupEnv, platform, fs);
    if (pathNode.ok && pathNode.via === 'exe' && pathNode.file.toLowerCase() === binary.file.toLowerCase()) {
      return { command: 'node', args: withScript };
    }
  }
  return { command: binary.file, args: withScript };
}

/**
 * One of Tars's own MCP servers (a bundled one, or the user's Tasmania):
 * `node <path>` for a .js, `npx tsx <path>` for a .ts, as each CLI will start
 * it (stdioServerCommand). An npx that cannot be resolved is written as given
 * and logged with the reason, under `label`.
 */
export function nodeServerCommand(
  serverPath: string, label: string, env?: Env, platform: NodeJS.Platform = process.platform, fs: FsProbe = realFs,
): { command: string; args: string[] } {
  const isTypeScript = serverPath.endsWith('.ts');
  const server = stdioServerCommand(isTypeScript ? 'npx' : 'node', isTypeScript ? ['tsx', serverPath] : [serverPath], env, platform, fs);
  if (server.unresolved) {
    console.warn(`MCP server ${label}: ${server.unresolved.name} not resolved (${server.unresolved.reason}): ${server.unresolved.detail}`);
  }
  return { command: server.command, args: server.args };
}

// ── Finding a CLI on Windows (Settings > CLI paths, Google Workspace) ─────────

/** Whether the lookup wants a CLI Tars will start, or a command file that only has to be there (gcloud.cmd, which gws runs). */
export type CliLookup = 'startable' | 'present';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const w = path.win32;

/** PATHEXT as lowercase extensions, in order (the resolver's own reading of it). */
function pathExts(env: Env): string[] {
  const raw = envValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT;
  const exts = raw.split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[^.\\/]+$/.test(e));
  return exts.length ? exts : DEFAULT_PATHEXT.toLowerCase().split(';');
}

/** `C:\...` or `\\server\share\...` with no other colon: anything else resolves against the current directory. */
function isPlainAbsolute(p: string): boolean {
  if (/^[a-z]:[\\/]/i.test(p)) return !p.slice(2).includes(':');
  return /^[\\/]{2}[^\\/]/.test(p) && !p.includes(':');
}

/** What only has to be there may still be a batch file the resolver cannot read through. */
const PRESENT_ENOUGH = new Set(['unrecognised-shim', 'shim-target-missing', 'node-not-found']);
/**
 * An npm node shim with no node on this PATH is still the CLI: node is found
 * when it starts, on the agent's PATH, which carries the node the user
 * configured (Settings > CLI paths > Node.js).
 */
const STARTABLE_ENOUGH = new Set(['node-not-found']);

/**
 * `file`, an absolute path with or without its extension, as the file a
 * Windows user means by it: the first `file + ext` in PATHEXT order that
 * exists, or `file` itself when it carries one of those extensions. Never the
 * extensionless sh shim npm writes beside a .cmd. With 'startable' the
 * resolver must be able to start it (node aside, see STARTABLE_ENOUGH); with
 * 'present' a command file that exists is enough.
 */
export function windowsCliFile(
  file: string, env: Env, lookup: CliLookup = 'startable', fs: FsProbe = realFs,
): { path: string } | { failure: CliBinaryFailure } {
  if (!isPlainAbsolute(file)) {
    return { failure: { ok: false, reason: 'invalid-name', name: file, detail: 'Not a plain absolute path: nothing is looked up relative to the current directory.' } };
  }
  const exts = pathExts(env);
  const own = w.extname(file).toLowerCase();
  const candidates = own && exts.includes(own) ? [file] : exts.map((e) => file + e);
  for (const candidate of candidates) {
    if (!fs.isFile(candidate)) continue;
    const binary = resolveCliBinary(candidate, env, 'win32', fs);
    if (binary.ok || (lookup === 'present' ? PRESENT_ENOUGH : STARTABLE_ENOUGH).has(binary.reason)) return { path: candidate };
    return { failure: binary };
  }
  // Nothing with an extension: the resolver says why (not there, or only the sh shim).
  const binary = resolveCliBinary(file, env, 'win32', fs);
  return binary.ok ? { path: file } : { failure: binary };
}

/**
 * The first of `dirs`, then of the env's PATH (unquoted, in order), that
 * holds `name`. `rejected` lists what was there and could not be used (the
 * sh shim alone, a shim whose target is gone), for the log; a folder that
 * does not hold it, or is not a plain absolute path, is skipped silently.
 */
export function findWindowsCli(
  name: string, dirs: string[], env: Env, lookup: CliLookup = 'startable', fs: FsProbe = realFs,
): { path?: string; rejected: CliBinaryFailure[] } {
  const rejected: CliBinaryFailure[] = [];
  const searched = [...dirs, ...pathEntries(getPath(env, 'win32'), 'win32').map(unquoteEntry)];
  for (const dir of searched) {
    const found = windowsCliFile(w.join(dir, name), env, lookup, fs);
    if ('path' in found) return { path: found.path, rejected };
    if (found.failure.reason !== 'not-found' && found.failure.reason !== 'invalid-name') rejected.push(found.failure);
  }
  return { rejected };
}

function profileDirs(env: Env) {
  const home = envValue(env, 'USERPROFILE', 'win32') || os.homedir();
  return {
    home,
    appData: envValue(env, 'APPDATA', 'win32') || w.join(home, 'AppData', 'Roaming'),
    localAppData: envValue(env, 'LOCALAPPDATA', 'win32') || w.join(home, 'AppData', 'Local'),
  };
}

/**
 * Where CLIs land on Windows, before the PATH is searched (macOS's
 * /opt/homebrew/bin and ~/.local/bin have no meaning there): the native
 * claude installer, npm -g, per-user installers, scoop, winget, the grok
 * installer, pnpm -g.
 */
export function windowsCliDirs(env: Env): string[] {
  const { home, appData, localAppData } = profileDirs(env);
  return [
    w.join(home, '.local', 'bin'),
    w.join(appData, 'npm'),
    w.join(localAppData, 'Programs'),
    w.join(home, 'scoop', 'shims'),
    w.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    w.join(home, '.grok', 'bin'),
    w.join(localAppData, 'pnpm'),
  ];
}

/** The Cloud SDK's bin folder: the per-user install, then the machine-wide ones. gcloud there is gcloud.cmd. */
export function windowsGcloudDirs(env: Env): string[] {
  const { localAppData } = profileDirs(env);
  const sdkBin = (root: string) => w.join(root, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin');
  const machine = ['ProgramFiles(x86)', 'ProgramFiles']
    .map((name) => envValue(env, name, 'win32'))
    .filter((root): root is string => !!root && isPlainAbsolute(root));
  return [sdkBin(localAppData), ...machine.map(sdkBin)];
}
