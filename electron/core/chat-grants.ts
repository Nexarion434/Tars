import * as fs from 'fs';
import * as path from 'path';

/**
 * The runner's copy of the project's settings.local.json goes with the chat:
 * Claude Code puts that file in the global git ignore, so it would otherwise
 * keep the whole worktree as an ignored file no commit has. The grants it
 * holds are the runner's own (the copy, and what Claude Code added since),
 * and the project keeps its own file. Only in the chat's own worktree, and
 * only a regular file in a .claude that is no link, and never the project's
 * own file, whatever links lead to it: any other ignored file still keeps the
 * worktree.
 */
export function dropRunnerGrants(projectPath: string, worktreePath: string | undefined, ownWorktreePath: string | undefined): void {
  if (!ownWorktreePath || !worktreePath || path.resolve(worktreePath) !== path.resolve(ownWorktreePath)) return;
  const dir = path.join(ownWorktreePath, '.claude');
  const grants = path.join(dir, 'settings.local.json');
  try {
    // lstat follows every component but the last: a linked .claude would reach the project's own file (#394's M1).
    // With both checked, nothing between the worktree and the file is a link.
    if (!fs.lstatSync(dir).isDirectory() || !fs.lstatSync(grants).isFile()) return;
    // Above the worktree, lstat follows everything: a chat's folder that is a link to the project reaches its file
    // (#394's delta gate, L1). One comparison covers any layout.
    if (fs.realpathSync(grants) === realpathOf(path.join(projectPath, '.claude', 'settings.local.json'))) return;
    fs.unlinkSync(grants);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[chat-grants] ${grants} not removed: ${(err as Error).message}`);
    return;
  }
  try { fs.rmdirSync(dir); } catch { /* .claude holds more: git decides about the rest */ }
}

function realpathOf(file: string): string | null {
  try { return fs.realpathSync(file); } catch { return null; }
}
