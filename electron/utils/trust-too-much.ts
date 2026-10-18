import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFilesystemRoot, isUnder, samePath } from '../platform/path-compare';

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
 * On Windows by the way Windows reads a path (platform/path-compare.ts): the
 * case, `/` for `\`, a trailing separator and a `\\?\` prefix are no other
 * folder (the Audit's L2 on #465), and a drive's or a share's root is a root.
 * Claude Code then shows its own dialog, which is the point of it. codex's
 * trust_level is refused on the same folders (providers/codex-cli.ts).
 */
export function trustsTooMuch(projectPath: string, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  // A drive-relative `C:demo` is not absolute either.
  if (!paths.isAbsolute(projectPath)) return true;
  const spellings = (p: string) => {
    const resolved = paths.resolve(p);
    try {
      return [resolved, fs.realpathSync.native(resolved)];
    } catch {
      return [resolved];
    }
  };
  const homes = spellings(home);
  return spellings(projectPath).some(dir =>
    isFilesystemRoot(dir, platform)
    || homes.some(h => samePath(h, dir, platform) || isUnder(h, dir, platform)));
}
