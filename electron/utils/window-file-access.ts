import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR, PRIVATE_DIR, VAULT_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';
import { isHardLinkInto, isWithinDir } from './path-identity';
import { landsUnderSafeRoot, realTarget } from './real-target';

/**
 * What the window may read, write, and have local-file:// serve (the Audit's
 * Holes 1 and 2, 2.0.4). The window is the renderer: a page with an XSS, or a
 * dependency of it gone bad, holds every channel the preload hands it, and
 * these three took paths.
 *
 * Writes: the instruction files the Brain edits, by name, and nothing else:
 * ~/.claude/CLAUDE.md, ~/.dorothy/CLAUDE.md, and a project's CLAUDE.md or
 * .claude/CLAUDE.md. fs:write-text-file wrote any text under ~/.dorothy,
 * ~/.claude, ~/.codex, ~/.gemini, ~/.grok and every project: statusline.sh
 * (which Claude Code runs), bin/tars-mcp-node (which every Tars MCP server
 * runs on), a CLI's hooks or config, a project's git hooks. One call from a
 * compromised page ran code in every agent.
 *
 * Reads (fs:read-text-file): what the Brain and the code panel show, under the
 * CLIs' folders and the projects, and of ~/.dorothy only its CLAUDE.md. Never a
 * secret: nothing under ~/.tars-private, the settings or a copy of them, the
 * shared token, the Hermes files, a CLI's own credentials, by name, by real
 * path, or through a hard link into the private folder.
 *
 * local-file:// (no page uses it in 2.0.4; the vault's previews go through
 * /api/local-file): the vault's attachments, the project-files folders and
 * Claude Code's memory folders, and nothing else.
 */

/** Files that hold a credential wherever they are, by their last name. */
const SECRET_NAMES = new Set([
  'app-settings.json', 'settings-secrets.json', 'api-token', 'hermes-connection.json', 'hermes-session.json',
  'hermes-token', 'hermes-webhook-secret', 'sentry-token',
  // The CLIs' own: Claude Code's on Linux, codex's, gemini's.
  '.credentials.json', 'auth.json', 'oauth_creds.json', 'google_accounts.json',
  '.env', '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.pgpass', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519',
]);

const nameIsSecret = (p: string) => {
  const name = path.basename(p).toLowerCase();
  return SECRET_NAMES.has(name) || name.startsWith('app-settings.json.') || name.startsWith('settings-secrets.json.');
};

/** A file the window must never get, judged as spelled, where it really lies, and by inode. */
export function isSecretFile(target: string): boolean {
  const resolved = path.resolve(target);
  const real = realTarget(resolved);
  if (!real) return true;
  if (nameIsSecret(resolved) || nameIsSecret(real)) return true;
  if (isUnder(resolved, PRIVATE_DIR) || samePath(resolved, PRIVATE_DIR) || isWithinDir(real, PRIVATE_DIR)) return true;
  return isHardLinkInto(real, PRIVATE_DIR);
}

const home = () => os.homedir();
const inside = (root: string, p: string) => samePath(root, p) || isUnder(p, root);
/** A project folder the window may reach: none that is ~/.dorothy, ~/.tars-private or in them. */
const projectRoots = (projects: string[]) => projects.filter((p) => typeof p === 'string' && p
  && !inside(DATA_DIR, path.resolve(p)) && !inside(PRIVATE_DIR, path.resolve(p)));

export function windowMayRead(target: string, projects: string[]): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  if (samePath(resolved, path.join(DATA_DIR, 'CLAUDE.md'))) return true;
  const real = realTarget(resolved);
  if (!real || isWithinDir(real, DATA_DIR)) return false;
  const roots = [path.join(home(), '.claude'), path.join(home(), '.codex'), path.join(home(), '.gemini'), path.join(home(), '.grok'), ...projectRoots(projects)];
  return landsUnderSafeRoot(resolved, roots, inside, { linkedMarkdown: true });
}

/** The instruction files the Brain edits, and only those. */
export function instructionFiles(projects: string[]): string[] {
  return [
    path.join(home(), '.claude', 'CLAUDE.md'),
    path.join(DATA_DIR, 'CLAUDE.md'),
    ...projectRoots(projects).flatMap((p) => [path.join(p, 'CLAUDE.md'), path.join(p, '.claude', 'CLAUDE.md')]),
  ];
}

export function windowMayWrite(target: string, projects: string[]): boolean {
  const resolved = path.resolve(target);
  if (!instructionFiles(projects).some((f) => samePath(f, resolved))) return false;
  if (isSecretFile(resolved)) return false;
  // Followed as the write follows it: what it really writes is a markdown file.
  const real = realTarget(resolved);
  return !!real && real.toLowerCase().endsWith('.md');
}

export function localFileServes(target: string): boolean {
  const resolved = path.resolve(target);
  if (isSecretFile(resolved)) return false;
  const roots = [path.join(VAULT_DIR, 'attachments'), path.join(DATA_DIR, 'project-files')];
  // ~/.claude/projects/<project>/memory/..., as spelled and where it really lies.
  const projectsDir = path.join(home(), '.claude', 'projects');
  const memory = (p: string, dir: string | undefined) => {
    if (!dir || !isUnder(p, dir)) return false;
    const parts = path.relative(dir, p).split(path.sep);
    return parts.length >= 3 && parts[1] === 'memory';
  };
  const real = realTarget(resolved);
  if (!real) return false;
  const served = landsUnderSafeRoot(resolved, roots, inside)
    || (memory(resolved, projectsDir) && memory(real, realTarget(projectsDir)));
  if (!served) return false;
  // A file with a second name may be that of anything (SECURITY.md §5).
  try {
    return fs.statSync(real).nlink < 2;
  } catch {
    return true;
  }
}
