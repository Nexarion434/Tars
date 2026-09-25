import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isUnder, samePath } from './path-compare';

/**
 * Whether a folder taken as a project root is the home, or holds it.
 *
 * The handlers that read and write files "under a project" (fs:read-text-file,
 * fs:write-text-file, fs:read-project-files, local-file://) take the projects
 * the user added, the agents' folders and the folders Claude has seen as
 * roots. A root that is the home or above it (`C:\Users`, `/Users`, `/`)
 * opens every file of the home: a shell profile, an SSH key, the Windows
 * Startup folder. Such a root is refused, by spelling (samePath, isUnder: case
 * and separators on win32) and by identity: a folder whose device and file id
 * are the home's or an ancestor's (a junction on win32, a symlink, a
 * case-insensitive volume on macOS) is the same folder under another name.
 *
 * win32: a bare drive (`C:`) is taken as its root, the widest reading.
 * A file id of 0 is no id (file systems that keep none report 0 for every
 * file). A root or a home that cannot be read is judged by its spelling alone.
 */

export interface HomeCoverDeps {
  home?: string;
  platform?: NodeJS.Platform;
  /** Device and file id of a path, undefined when it cannot be read. */
  stat?: (p: string) => { dev: bigint; ino: bigint } | undefined;
}

function fileId(p: string): { dev: bigint; ino: bigint } | undefined {
  try {
    const s = fs.statSync(p, { bigint: true });
    return { dev: s.dev, ino: s.ino };
  } catch {
    return undefined;
  }
}

/** The test, with the home and the ids of the home and its ancestors read once. */
function homeCoverTest(deps: HomeCoverDeps = {}): (root: string) => boolean {
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const stat = (target: string) => {
    try {
      const id = (deps.stat ?? fileId)(target);
      return id && id.ino !== BigInt(0) ? id : undefined;
    } catch {
      return undefined;
    }
  };
  let above: { dev: bigint; ino: bigint }[] | undefined;
  const homeAndAbove = () => {
    if (above) return above;
    above = [];
    for (let dir = home; ; dir = p.dirname(dir)) {
      const id = stat(dir);
      if (id) above.push(id);
      if (p.dirname(dir) === dir) break;
    }
    return above;
  };
  return (asGiven: string) => {
    if (!asGiven) return false;
    // `C:` alone is the drive's current folder to Windows, but a caller that
    // appends a separator to test a prefix reads it as `C:\`: the wider one.
    const root = platform === 'win32' && /^[A-Za-z]:$/.test(asGiven) ? `${asGiven}\\` : asGiven;
    if (samePath(root, home, platform) || isUnder(home, root, platform)) return true;
    const id = stat(root);
    return !!id && homeAndAbove().some(h => h.dev === id.dev && h.ino === id.ino);
  };
}

export function coversHome(root: string, deps: HomeCoverDeps = {}): boolean {
  return homeCoverTest(deps)(root);
}

/** `roots` less every one that is the home or holds it, in order. */
export function withoutHomeCover(roots: string[], deps: HomeCoverDeps = {}): string[] {
  const covers = homeCoverTest(deps);
  return roots.filter(root => !covers(root));
}
