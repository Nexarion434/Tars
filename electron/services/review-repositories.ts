import * as fs from 'fs';
import * as path from 'path';
import { safeGit } from '../utils/safe-git';

/**
 * Review, every repository of a project (2.0.4, the frames "Review · projects
 * and their repositories" of #457, the Audit's requirements for 2.0.4,
 * section 2). A project is one repository, holds repositories at any depth,
 * has no git, or is gone. The scan reads the whole folder with no depth or
 * count limit, past node_modules, .git, .worktrees, .claude/worktrees and
 * every hidden folder, follows no link (a link to the home would bring its
 * repositories in: R2.2), and does not look inside a repository: its
 * worktrees are git's to list. Each repository is said as it is found. git
 * runs through safe-git (#463): no program a repository's own config names
 * runs, and argv only.
 */

export type ProjectState = 'gone' | 'unreachable' | 'no-git' | 'repository' | 'repositories';

export interface ProjectScan {
  projectPath: string;
  state: ProjectState;
  /** Absolute, in the order found. */
  repos: string[];
  /** The folders the scan could not open, and why: said, never fatal. */
  skipped: Array<{ path: string; why: string }>;
  foldersRead: number;
}

const SKIPPED_NAMES = new Set(['node_modules', '.git', '.worktrees']);

function errnoText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOENT') return 'gone';
  return code ?? (err as Error)?.message ?? String(err);
}

/** A folder holding .git: a repository, a worktree (a .git file) included. */
function holdsGit(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every repository under a project's folder. Reads one folder at a time and
 * yields between them, so a project of 200,000 folders does not hold the
 * main process; `signal` stops it where it stands.
 */
export async function scanProject(
  projectPath: string,
  opts: { onRepo?: (repo: string) => void; onProgress?: (foldersRead: number, repos: number) => void; signal?: AbortSignal } = {},
): Promise<ProjectScan> {
  const scan: ProjectScan = { projectPath, state: 'no-git', repos: [], skipped: [], foldersRead: 0 };
  try {
    if (!fs.statSync(projectPath).isDirectory()) return { ...scan, state: 'gone' };
  } catch (err) {
    // A drive that is not there (Windows) is not a folder deleted.
    const code = (err as NodeJS.ErrnoException).code;
    return { ...scan, state: code === 'ENOENT' || code === 'ENOTDIR' ? (/^[A-Za-z]:[\\/]/.test(projectPath) && !fs.existsSync(projectPath.slice(0, 3)) ? 'unreachable' : 'gone') : 'unreachable' };
  }
  const found = (repo: string) => { scan.repos.push(repo); opts.onRepo?.(repo); };
  if (holdsGit(projectPath)) {
    found(projectPath);
    return { ...scan, state: 'repository', foldersRead: 1 };
  }
  const stack = [projectPath];
  let sinceYield = 0;
  while (stack.length) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      scan.skipped.push({ path: dir, why: errnoText(err) });
      continue;
    }
    scan.foldersRead++;
    const subdirs: string[] = [];
    for (const e of entries) {
      // Only folders, never a link to one (Dirent does not follow links).
      if (!e.isDirectory() || SKIPPED_NAMES.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(dir, e.name);
      if (holdsGit(sub)) found(sub);
      else subdirs.push(sub);
    }
    // In name order, as a person reads the folder.
    stack.push(...subdirs.sort().reverse());
    if (++sinceYield >= 50) {
      sinceYield = 0;
      opts.onProgress?.(scan.foldersRead, scan.repos.length);
      await new Promise((r) => setImmediate(r));
    }
  }
  opts.onProgress?.(scan.foldersRead, scan.repos.length);
  return { ...scan, state: scan.repos.length ? 'repositories' : 'no-git' };
}

export interface ChangedFile {
  file: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  additions: number | null;
  deletions: number | null;
}

export interface RepositoryState {
  path: string;
  branch: string;
  changed: ChangedFile[];
  /** The branch it is compared with (origin's default, main or master), and how many commits ahead of it. */
  base: string | null;
  ahead: number | null;
  /** The agents whose folder is this repository or inside it. */
  agents: Array<{ id: string; name: string }>;
  error?: string;
}

const UNTRACKED_LINES_MAX_BYTES = 256 * 1024;

function statusOf(code: string): ChangedFile['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflict';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

const within = (inner: string, outer: string) => {
  const rel = path.relative(outer, inner);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A repository as the list and the search show it: its branch, what changed, how far ahead, who works there. */
export async function repositoryState(repoPath: string, agents: Array<{ id: string; name: string; path: string }>): Promise<RepositoryState> {
  const state: RepositoryState = {
    path: repoPath, branch: '', changed: [], base: null, ahead: null,
    agents: agents.filter((a) => a.path && within(path.resolve(a.path), repoPath)).map((a) => ({ id: a.id, name: a.name })),
  };
  const run = async (args: string[]) => (await safeGit(repoPath, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  try {
    state.branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = status.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      // A rename names its old path in the next part.
      if (code.includes('R') || code.includes('C')) i++;
      state.changed.push({ file, status: statusOf(code), additions: null, deletions: null });
    }
    const byFile = new Map(state.changed.map((c) => [c.file, c]));
    const numstat = await run(['diff', '--numstat', '-z', 'HEAD']).catch(() => '');
    for (const line of numstat.split('\0')) {
      const [add, del, file] = line.split('\t');
      const c = file ? byFile.get(file) : undefined;
      if (!c) continue;
      c.additions = add === '-' ? null : Number(add);
      c.deletions = del === '-' ? null : Number(del);
    }
    for (const c of state.changed) {
      if (c.status !== 'untracked') continue;
      try {
        const file = path.join(repoPath, c.file);
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= UNTRACKED_LINES_MAX_BYTES) {
          const text = fs.readFileSync(file);
          if (!text.includes(0)) {
            c.additions = text.length === 0 ? 0 : text.toString('utf8').split('\n').length - (text[text.length - 1] === 0x0a ? 1 : 0);
            c.deletions = 0;
          }
        }
      } catch { /* gone meanwhile */ }
    }
    const originHead = (await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    for (const candidate of [originHead, 'main', 'master'].filter(Boolean)) {
      if (candidate === state.branch) break;
      const ok = await run(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).then(() => true, () => false);
      if (!ok) continue;
      state.base = candidate;
      state.ahead = Number((await run(['rev-list', '--count', `${candidate}..HEAD`])).trim()) || 0;
      break;
    }
  } catch (err) {
    state.error = ((err as { stderr?: string }).stderr || (err as Error).message || String(err)).trim().split('\n')[0];
  }
  return state;
}

export interface SearchGroup {
  project: string;
  repo: string;
  branch: string;
  /** The repository's name or its path in the project matched. */
  nameMatch: boolean;
  files: string[];
}

const BATCH = 200;

/**
 * Every repository whose name or path in its project holds the query, and
 * every changed file whose path does, case aside, across every project, with
 * no limit: sent in batches of about 200 results, grouped by repository. The
 * query is text, never an option or a pattern. Returns how many results it
 * sent.
 */
export async function searchRepositories(
  query: string,
  entries: Array<{ project: string; repos: RepositoryState[] }>,
  onBatch: (batch: SearchGroup[]) => void,
  signal?: AbortSignal,
): Promise<number> {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let total = 0;
  let batch: SearchGroup[] = [];
  let inBatch = 0;
  const flush = async () => {
    if (!batch.length) return;
    onBatch(batch);
    batch = [];
    inBatch = 0;
    await new Promise((r) => setImmediate(r));
  };
  for (const { project, repos } of entries) {
    for (const r of repos) {
      if (signal?.aborted) return total;
      const rel = path.relative(project, r.path) || path.basename(r.path);
      const nameMatch = rel.toLowerCase().includes(q) || path.basename(r.path).toLowerCase().includes(q);
      const files = r.changed.map((c) => c.file).filter((f) => f.toLowerCase().includes(q));
      if (!nameMatch && !files.length) continue;
      total += files.length + (nameMatch && !files.length ? 1 : 0);
      // A repository with many matches goes in parts, each a batch's size.
      for (let at = 0; at < Math.max(files.length, 1); at += BATCH) {
        const part = files.slice(at, at + BATCH);
        batch.push({ project, repo: r.path, branch: r.branch, nameMatch, files: part });
        inBatch += Math.max(part.length, 1);
        if (inBatch >= BATCH) await flush();
      }
    }
  }
  await flush();
  return total;
}

/** Whether the window may review this path: a repository Tars found in a project, or an agent's worktree, nothing else (R2.4). */
export function mayReview(repoPath: unknown, known: ReadonlySet<string>): boolean {
  if (typeof repoPath !== 'string' || !repoPath || !path.isAbsolute(repoPath)) return false;
  const resolved = path.resolve(repoPath);
  for (const k of known) if (path.resolve(k) === resolved) return true;
  return false;
}
