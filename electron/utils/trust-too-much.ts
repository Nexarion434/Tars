import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Whether marking this directory trusted would trust far more than a project.
 *
 * Claude Code reads `hasTrustDialogAccepted` for its working directory and
 * every directory above it, so the flag on $HOME trusts everything the account
 * owns and the flag on `/` trusts the machine. Refused: the root, the home
 * directory, anything above it, and a relative path, which names whatever the
 * app's working directory happens to be. Compared by the path given and by the
 * path the filesystem resolves, which follows a link and, on macOS, gives the
 * case the disk stores, so neither a link nor another spelling gets through.
 * Claude Code then shows its own dialog, which is the point of it. codex's
 * trust_level is refused on the same folders (providers/codex-cli.ts).
 */
export function trustsTooMuch(projectPath: string): boolean {
  if (!path.isAbsolute(projectPath)) return true;
  const spellings = (p: string) => {
    const resolved = path.resolve(p);
    try {
      return [resolved, fs.realpathSync.native(resolved)];
    } catch {
      return [resolved];
    }
  };
  const homes = spellings(os.homedir());
  return spellings(projectPath).some(dir =>
    dir === path.parse(dir).root
    || homes.some(home => home === dir || home.startsWith(dir + path.sep)));
}
