import type { AgentStatus } from '@/types/electron';
import { comparablePath, pathName, splitPath, tildePath } from '@/lib/display-path';

/**
 * What Review's left column says of every project and every repository (2.0.4, #472's scan; frames `Review ·
 * projects and their repositories`, `· search`, `· states`). Its failures are listed, and pinned, in
 * __tests__/lib/review-repositories.test.ts.
 */

const withoutTrailing = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);

/** The projects Review reads: those added in Tars and those an agent works in, once each, by name. */
export function reviewProjects(
  agents: AgentStatus[],
  projects: Array<{ path: string; name?: string; custom?: boolean }>,
): string[] {
  const byKey = new Map<string, string>();
  const add = (p: string | undefined | null) => {
    if (!p) return;
    const clean = withoutTrailing(p);
    const key = comparablePath(clean);
    if (!byKey.has(key)) byKey.set(key, clean);
  };
  for (const project of projects) if (project.custom) add(project.path);
  for (const agent of agents) add(agent.projectPath);
  return [...byKey.values()].sort((a, b) => (pathName(a) || a).localeCompare(pathName(b) || b) || a.localeCompare(b));
}

/** A repository's name in its project: its path inside it, the project's own name for itself, its folder elsewhere. */
export function insidePath(projectPath: string, repoPath: string): string {
  const project = splitPath(withoutTrailing(projectPath));
  const repo = splitPath(withoutTrailing(repoPath));
  const nested = project.parts.length <= repo.parts.length
    && project.parts.every((part, i) => comparablePath(part) === comparablePath(repo.parts[i]));
  if (!nested) return pathName(repoPath) || repoPath;
  const rest = repo.parts.slice(project.parts.length);
  return rest.length ? rest.join('/') : pathName(projectPath) || projectPath;
}

export type SearchRow =
  | { kind: 'repo'; project: string; repo: string; label: string; branch: string }
  | { kind: 'file'; project: string; repo: string; label: string; file: string; branch: string };

/** Main's search batches as rows, in its order: a repository for its name, each changed file with its repository. */
export function searchRows(groups: Array<{ project: string; repo: string; branch: string; nameMatch: boolean; files: string[] }>): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const g of groups) {
    const project = pathName(g.project) || g.project;
    const name = insidePath(g.project, g.repo);
    for (const file of g.files) rows.push({ kind: 'file', project, repo: g.repo, label: `${name}/${file}`, file, branch: g.branch });
    if (g.nameMatch) rows.push({ kind: 'repo', project, repo: g.repo, label: name, branch: g.branch });
  }
  return rows;
}

/** What a search that found nothing says, with how much it looked through. */
export function nothingFoundLine(query: string, repositories: number, projects: number): string {
  const yours = projects === 1 ? 'your project' : `your ${projects} projects`;
  if (repositories === 0) return `Nothing named ${query}: no repository in ${yours}.`;
  const them = repositories === 1 ? 'the one repository' : `the ${repositories} repositories`;
  return `Nothing named ${query} in ${them} of ${yours}, nor in ${repositories === 1 ? 'its' : 'their'} changed files.`;
}

/** A scan still running: the folder from home, how many folders read and repositories found. */
export function progressLine(projectPath: string, foldersRead: number, repositories: number): string {
  const folders = `${foldersRead} folder${foldersRead === 1 ? '' : 's'} read`;
  const repos = `${repositories} repositor${repositories === 1 ? 'y' : 'ies'} so far`;
  return `Looking through ${tildePath(projectPath)}: ${folders}, ${repos}. Each shows as it is found.`;
}
