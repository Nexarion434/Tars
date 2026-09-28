import { execFileSync as nodeExecFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Env } from './fs-probe';
import { envValue } from './path-env';

/**
 * Close a secret file, or the private directory, to every account but its
 * owner, on Windows (audit B S-01, the decision in tasks/todo.md).
 *
 * `0o600` and `0o700` do nothing there: Node maps chmod to the read-only bit.
 * What stands in for them is the access list: the current user and SYSTEM,
 * full control, nothing inherited, so a grant added to the folder later (Codex
 * adds `CodexSandboxUsers` to the folders its sandbox reads, with (OI)(CI))
 * does not reach the file either. The Administrators group the profile hands
 * down goes too; an administrator can take the file back, so that is not a
 * boundary, only no standing grant.
 *
 * Not a boundary against the agents: they run as the same user, and the user
 * keeps full control. What it keeps out is the other accounts on the machine,
 * the sandbox accounts included (SECURITY.md section 7).
 *
 * icacls and whoami by their absolute path under %SystemRoot%\System32, never
 * looked up on the PATH (where an agent's project could plant one), with an
 * argv; the user named by SID (`*S-1-5-21-...`), never by a name icacls would
 * have to resolve, and SYSTEM by its well-known SID, so nothing depends on the
 * language of the machine. The SID is asked of `whoami /user` once per process.
 *
 * Never throws: a failure is logged with the path and reported, and the caller
 * keeps what it wrote. darwin/linux: nothing runs, the answer is `skipped`.
 */

export const SYSTEM_SID = 'S-1-5-18';

/** `skipped`: not win32, or nothing there to close. `failed`: logged, the file left as it was. */
export type OwnerOnlyResult = 'skipped' | 'restricted' | 'failed';

export interface OwnerOnlyDeps {
  platform?: NodeJS.Platform;
  env?: Env;
  /** Runs a program, returns its stdout; throws as child_process.execFileSync does. */
  execFileSync?: (file: string, args: readonly string[]) => string;
  warn?: (message: string) => void;
}

export interface OwnerOnlyOptions {
  /**
   * Drop the file's explicit entries too (`icacls /reset` first), for a file
   * that already existed: one Tars just created has none, only what it
   * inherited, which `/inheritance:r` removes.
   */
  replaceExplicit?: boolean;
}

const SID_SHAPE = /^S-1-\d+(-\d+)+$/;

/** A hung icacls must not hold the main process for ever. */
const TIMEOUT_MS = 10_000;

const runReal = (file: string, args: readonly string[]): string =>
  nodeExecFileSync(file, args as string[], {
    encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The SID in `whoami /user /fo csv /nh`: `"domain\name","S-1-5-21-..."`. The
 * last quoted field, so a name with a comma or a doubled quote does not shift
 * it; null for anything that is not a SID.
 */
export function parseWhoamiUserSid(stdout: string): string | null {
  const last = /"([^"]*)"\s*$/.exec(stdout.trim())?.[1];
  return last && SID_SHAPE.test(last) ? last : null;
}

let cachedSid: string | undefined;

function system32(deps: OwnerOnlyDeps, exe: string): string {
  const systemRoot = envValue(deps.env ?? process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', exe);
}

function userSid(deps: OwnerOnlyDeps, run: NonNullable<OwnerOnlyDeps['execFileSync']>): string {
  // Cached only for the real runner: an injected one is a test's own world.
  if (!deps.execFileSync && cachedSid) return cachedSid;
  const out = run(system32(deps, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = parseWhoamiUserSid(String(out ?? ''));
  if (!sid) throw new Error('whoami /user gave no SID');
  if (!deps.execFileSync) cachedSid = sid;
  return sid;
}

function why(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown };
  const said = `${String(e.stderr ?? '')} ${String(e.stdout ?? '')}`.replace(/\s+/g, ' ').trim();
  const code = e.status ?? e.code;
  return [code === undefined ? e.message : `exit ${String(code)}`, said].filter(Boolean).join(': ');
}

function grant(target: string, kind: 'file' | 'directory', options: OwnerOnlyOptions, deps: OwnerOnlyDeps): OwnerOnlyResult {
  const run = deps.execFileSync ?? runReal;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const sid = userSid(deps, run);
    const icacls = system32(deps, 'icacls.exe');
    const inherit = kind === 'directory' ? '(OI)(CI)' : '';
    if (options.replaceExplicit) run(icacls, [target, '/reset']);
    run(icacls, [target, '/inheritance:r', '/grant:r', `*${sid}:${inherit}(F)`, `*${SYSTEM_SID}:${inherit}(F)`]);
    return 'restricted';
  } catch (err) {
    warn(`[secret-acl] ${target} keeps the access list its folder hands down: ${why(err)}`);
    return 'failed';
  }
}

/**
 * Leave `target` (a file) with the user and SYSTEM only, full control,
 * inheritance removed.
 */
export function restrictToOwnerSync(target: string, options: OwnerOnlyOptions = {}, deps: OwnerOnlyDeps = {}): OwnerOnlyResult {
  if ((deps.platform ?? process.platform) !== 'win32') return 'skipped';
  return grant(target, 'file', options, deps);
}

/**
 * Close a directory the same way, handing the two entries down to whatever is
 * made in it later, and bring what is in it now to exactly that: each entry
 * loses its own list (`/reset`) and takes the directory's. One level, as
 * narrowDataDir: the private directory has no subdirectories. A link or a
 * junction is never followed or reset, since what it points at may be any
 * file the account owns (~/.ssh). A missing directory is skipped quietly.
 */
export function restrictDirToOwnerSync(dir: string, deps: OwnerOnlyDeps = {}): OwnerOnlyResult {
  if ((deps.platform ?? process.platform) !== 'win32') return 'skipped';
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return 'skipped';
    names = fs.readdirSync(dir);
  } catch {
    return 'skipped';
  }
  const own = grant(dir, 'directory', { replaceExplicit: true }, deps);
  if (own !== 'restricted') return own;
  const run = deps.execFileSync ?? runReal;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let result: OwnerOnlyResult = 'restricted';
  for (const name of names) {
    const entry = path.join(dir, name);
    try {
      if (fs.lstatSync(entry).isSymbolicLink()) continue;
      run(system32(deps, 'icacls.exe'), [entry, '/reset']);
    } catch (err) {
      warn(`[secret-acl] ${entry} keeps its own access list: ${why(err)}`);
      result = 'failed';
    }
  }
  return result;
}
