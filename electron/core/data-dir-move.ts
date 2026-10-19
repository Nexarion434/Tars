import * as fs from 'fs';
import * as path from 'path';

/**
 * Tars's data folder is ~/.tars since 2.0.4 (the maintainer's decision of
 * 18/10), and was ~/.dorothy. It moves once, at the start, before anything
 * reads or writes it: constants/index.ts settles it as it loads, and every
 * path of the app is computed from what it answers.
 *
 * The move is one rename in the home folder, which the system does whole or
 * not at all: stopped at any moment, the data is in one place or the other,
 * never in both, never half. A link is then left at ~/.dorothy (a junction on
 * Windows, which needs no privilege) for what outside Tars still names the
 * old path: a CLI's settings Tars has not rewritten yet, an agent started by
 * an older Tars, a script of the user's. It is for 2.0.4 only; the next
 * version removes it.
 *
 * Nothing here deletes, copies or merges: when the folder cannot be moved
 * (Windows refuses to rename a folder a process holds), Tars goes on from
 * ~/.dorothy for this run and tries again at the next start; when both are
 * real folders, ~/.tars is used and ~/.dorothy is left as it is. This file
 * imports nothing of the app's: it runs before the app's paths exist.
 */

export const DATA_DIR_NAME = '.tars';
export const LEGACY_DATA_DIR_NAME = '.dorothy';

export interface DataDirOutcome {
  /** The folder this run uses. */
  dir: string;
  /** moved: this start moved it; already: it was moved before; kept-old: it could not move; both: two real folders; none: a first start. */
  did: 'moved' | 'already' | 'kept-old' | 'both' | 'none';
  /** Whether a link is at ~/.dorothy, made now or before. */
  linked: boolean;
  why?: string;
}

interface Deps {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  symlink?: (target: string, at: string, type?: 'dir' | 'junction') => void;
}

function kind(p: string): 'dir' | 'link' | 'file' | 'none' {
  try {
    const s = fs.lstatSync(p);
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

const reason = (err: unknown) => `${(err as NodeJS.ErrnoException)?.code ?? ''} ${(err as Error)?.message ?? String(err)}`.trim();

export function settleDataDir(home: string, deps: Deps = {}): DataDirOutcome {
  const platform = deps.platform ?? process.platform;
  const rename = deps.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  const symlink = deps.symlink ?? ((target: string, at: string, type?: 'dir' | 'junction') => fs.symlinkSync(target, at, type));
  const tars = path.join(home, DATA_DIR_NAME);
  const old = path.join(home, LEGACY_DATA_DIR_NAME);

  /** The link at the old place, for 2.0.4: made, or why it was not. */
  const link = (): { linked: boolean; why?: string } => {
    try {
      // Relative where it can be, so a home that moves keeps it whole; Windows takes a junction's absolute target.
      if (platform === 'win32') symlink(tars, old, 'junction');
      else symlink(DATA_DIR_NAME, old, 'dir');
      return { linked: true };
    } catch (err) {
      return { linked: false, why: `no link left at ${old}: ${reason(err)}` };
    }
  };

  const t = kind(tars);
  const o = kind(old);
  if (t === 'file') {
    return { dir: old, did: 'kept-old', linked: false, why: `${tars} is a file, not a folder: Tars stays in ${old}` };
  }
  if (t === 'dir' || t === 'link') {
    if (o === 'link') return { dir: tars, did: 'already', linked: true };
    if (o === 'dir') return { dir: tars, did: 'both', linked: false, why: `${old} is a folder of its own beside ${tars}: Tars uses ${tars}, and leaves ${old} as it is` };
    if (o === 'file') return { dir: tars, did: 'already', linked: false, why: `${old} is a file: no link left there` };
    return { dir: tars, did: 'already', ...link() };
  }
  if (o === 'none' || o === 'file') return { dir: tars, did: 'none', linked: false };
  try {
    rename(old, tars);
  } catch (err) {
    return { dir: old, did: 'kept-old', linked: false, why: `${old} could not be moved to ${tars} (${reason(err)}): Tars goes on from it, and moves it at the next start` };
  }
  return { dir: tars, did: 'moved', ...link() };
}

/** What a file rewritten keeps: under 4 MB, text. */
const REWRITE_MAX_BYTES = 4 * 1024 * 1024;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The old folder's path where Tars wrote it in a file outside its folder (a
 * CLI's settings and MCP servers, a status line, a scheduled job), rewritten
 * to the new one in every form Tars writes it: the absolute path, `~/`,
 * `$HOME/`, `${HOME}/`, and on Windows the path as JSON escapes it. A name
 * that only starts the same (`.dorothy-backup`) is not touched. A file
 * nothing changed in is not written; one that is keeps its mode, and is
 * written to a file of its own beside it, renamed over it. Answers the files
 * it rewrote.
 */
export function rewriteLegacyPaths(opts: { home: string; files: string[]; winHome?: string }): string[] {
  const end = '(?![\\w.\\-])';
  const forms: Array<[RegExp, string]> = [];
  const add = (from: string, to: string) => forms.push([new RegExp(escapeRe(from) + end, 'g'), to]);
  add(path.join(opts.home, LEGACY_DATA_DIR_NAME), path.join(opts.home, DATA_DIR_NAME));
  for (const prefix of ['~/', '$HOME/', '${HOME}/']) add(prefix + LEGACY_DATA_DIR_NAME, prefix + DATA_DIR_NAME);
  if (opts.winHome) {
    add(`${opts.winHome}\\${LEGACY_DATA_DIR_NAME}`, `${opts.winHome}\\${DATA_DIR_NAME}`);
    const json = (s: string) => s.replace(/\\/g, '\\\\');
    add(json(`${opts.winHome}\\${LEGACY_DATA_DIR_NAME}`), json(`${opts.winHome}\\${DATA_DIR_NAME}`));
  }
  const changed: string[] = [];
  for (const file of opts.files) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > REWRITE_MAX_BYTES) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    let next = text;
    for (const [re, to] of forms) next = next.replace(re, () => to);
    if (next === text) continue;
    const temp = `${file}.tars-move-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, next, { mode: stat.mode & 0o777, flag: 'wx' });
      fs.renameSync(temp, file);
      changed.push(file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      console.warn(`[data-dir] ${file} still names ${LEGACY_DATA_DIR_NAME}, which the link covers in 2.0.4: ${reason(err)}`);
    }
  }
  return changed;
}

/**
 * The files the old path may be written in: what Tars writes outside its
 * folder (each CLI's settings and MCP servers, the status line, each Claude
 * account's folder, Tars's own launchd jobs) and its own records that hold
 * absolute paths (its JSON files, the scheduled scripts, Qwen Code's per-agent
 * settings). Logs and ledgers are left as they are: they say what was.
 */
export function legacyPathFiles(home: string, dataDir: string): string[] {
  const list = (dir: string, keep: (name: string) => boolean): string[] => {
    try {
      return fs.readdirSync(dir).filter(keep).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };
  const claudeFiles = (dir: string) => ['settings.json', 'settings.local.json', 'mcp.json'].map((f) => path.join(dir, f));
  const accounts = list(path.join(home, '.claude-accounts'), () => true)
    .flatMap((dir) => [path.join(dir, '.claude.json'), ...claudeFiles(dir)]);
  return [
    path.join(home, '.claude.json'), ...claudeFiles(path.join(home, '.claude')), ...accounts,
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.gemini', 'settings.json'),
    path.join(home, '.grok', 'config.toml'), path.join(home, '.grok', 'user-settings.json'),
    path.join(home, '.opencode', 'config.json'), path.join(home, '.config', 'opencode', 'opencode.json'),
    path.join(home, '.pi', 'mcp.json'), path.join(home, '.pi', 'settings.json'), path.join(home, '.pi', 'agent', 'settings.json'),
    path.join(home, '.config', 'amp', 'settings.json'),
    path.join(home, '.qwen', 'settings.json'),
    ...list(path.join(home, 'Library', 'LaunchAgents'), (n) => /^(xyz\.cooperlabs\.tars|com\.dorothy|com\.tars)/.test(n) && n.endsWith('.plist')),
    ...list(dataDir, (n) => n.endsWith('.json')),
    ...list(path.join(dataDir, 'scripts'), (n) => n.endsWith('.sh')),
    ...list(path.join(dataDir, 'qwen-code'), () => true).flatMap((d) => list(d, (n) => n.endsWith('.json'))),
  ];
}
