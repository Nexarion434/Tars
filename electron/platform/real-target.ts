import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR_NAME, PRIVATE_DIR_NAME } from '../constants';
import { isWithinDir } from '../utils/path-identity';
import { credentialStoreDirs } from './credential-stores';
import { isUnderSafeRoot, withoutHomeCover, type HomeCoverDeps } from './home-root';
import { isUnder, samePath } from './path-compare';

/**
 * Where a read or a write of a path really lands, and whether that is under a
 * root that is not the home nor above it.
 *
 * The file handlers (fs:read-text-file, fs:write-text-file,
 * fs:read-project-files, local-file://) judged the path as spelled, then
 * readFileSync / writeFileSync followed every link on the way. ~/.dorothy is
 * one of their roots and every agent is handed it: one junction or symlink in
 * it to the home opened ~/.ssh and ~/.tars-private, to read and to write, and
 * a symlink in a cloned repository did the same through its project. So the
 * target is followed as the call will follow it, and its real location must
 * lie under the real location of a root, in addition to the spelled check.
 *
 * A target that does not exist yet (a write that creates it) is judged by its
 * nearest existing folder, the one the file will be created in. A link to
 * nothing, in its place or on the way, is refused: realpath cannot follow it,
 * and a write would, creating the file wherever it points.
 *
 * "Under" is by identity (device and file id, read as BigInt, as
 * utils/path-identity.ts says why) or by the spelling of both real paths, so a
 * root that is itself a link, an 8.3 name, a `\\?\` prefix, another case on
 * win32 or a firmlink on macOS all compare as the folder they name. A file id
 * of 0 is no id. The same code on every platform.
 *
 * Only the roots the target or its real path is under by spelling are looked
 * at on the disk, as isUnderSafeRoot does (a stat on an offline share was
 * measured at 21 s).
 *
 * One exception, asked for by name (`linkedMarkdown`), and only by the
 * renderer's IPC reads and writes (fs:read-text-file, fs:write-text-file,
 * fs:read-project-files), the Brain page's instruction files.
 * /api/local-file (no token) and local-file:// stay strict: there it would
 * serve any note in the home through a link planted under ~/.dorothy. The exception is for the file that is a link to a
 * dotfiles repository:
 * `~/.claude/CLAUDE.md`, or a project's CLAUDE.md or AGENTS.md, linked to a
 * shared file outside every root (common among Claude Code users; refusing it
 * broke the Brain page). The target's last name may be a FILE link out of
 * every root when everything above it really lies in a root (a folder link
 * on the way is the escape itself: DATA_DIR linked to the home) and the file
 * it finally leads to passes linkedFileAllowed.
 *
 * What remains: the check and the read or write that follows are two calls,
 * so a link swapped in between is followed. Whoever can swap it runs as the
 * same user and can open the file directly (SECURITY.md §1). A hard link has
 * no path back to the file it names and passes (SECURITY.md §5).
 */

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * The real path of `target`, links followed; for a target that does not exist,
 * the real path of its nearest existing folder with the missing names after
 * it. Undefined when that cannot be told: a link to nothing on the way, a
 * loop, a folder that cannot be read.
 */
export function realTarget(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch (err) {
    if (code(err) !== 'ENOENT') return undefined;
  }
  const missing: string[] = [];
  for (let dir = target; ;) {
    // Missing to realpath, present to lstat: a link to nothing.
    try {
      fs.lstatSync(dir);
      return undefined;
    } catch (err) {
      if (code(err) !== 'ENOENT') return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    missing.unshift(path.basename(dir));
    dir = parent;
    try {
      return path.join(fs.realpathSync.native(dir), ...missing);
    } catch (err) {
      if (code(err) !== 'ENOENT') return undefined;
    }
  }
}

type FileId = { dev: bigint; ino: bigint };

function fileId(p: string): FileId | undefined {
  try {
    const s = fs.statSync(p, { bigint: true });
    return s.ino === BigInt(0) ? undefined : { dev: s.dev, ino: s.ino };
  } catch {
    return undefined;
  }
}

function realPath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

type Inside = (root: string, target: string) => boolean;

/** `real` (a real path) is a safe root, or inside one, among those `spelled` or `real` is under by spelling. */
function inRealRoot(spelled: string, real: string, roots: string[], isInside: Inside, deps: HomeCoverDeps): boolean {
  const candidates = withoutHomeCover(roots.filter(root => isInside(root, spelled) || isInside(root, real)), deps)
    .map(root => ({ real: realPath(root), id: fileId(root) }))
    .filter(root => root.real || root.id);
  for (let dir = real; ; dir = path.dirname(dir)) {
    const id = fileId(dir);
    if (candidates.some(root => (root.real && samePath(dir, root.real))
      || (id && root.id && id.dev === root.id.dev && id.ino === root.id.ino))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Places a linked file may never lead into: the Telegram guard's list
 * (services/api-routes/utils.ts isSafeTelegramPath), `~/.config/gh` inside
 * it, and on win32 the credential stores under AppData.
 */
function blockedPlaces(home: string): string[] {
  return [
    '.ssh', '.gnupg', '.aws', '.claude', '.env', DATA_DIR_NAME, PRIVATE_DIR_NAME,
    '.config', '.kube', '.docker', '.netrc', '.git-credentials',
  ].map(name => path.join(home, name)).concat(credentialStoreDirs({ home }));
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/**
 * Whether a file a link leads to (`realFile`, its real path) may be read and
 * written through that link from outside every root: a regular file, named as
 * markdown, in no blocked place (by spelling, and by identity for a place
 * reached under another name).
 *
 * Markdown only: the Brain page reads and saves CLAUDE.md, AGENTS.md, SKILL.md
 * and README.md, and a credential is not kept in one. The link's own name is
 * whatever the link's maker chose and says nothing; the name of the file it
 * leads to is the file's. So a link to ~/.npmrc, a shell history or a key is
 * refused wherever it lives, not only in the places listed.
 */
export function linkedFileAllowed(realFile: string, deps: { home?: string } = {}): boolean {
  const home = deps.home ?? os.homedir();
  if (!MARKDOWN.test(path.basename(realFile))) return false;
  try {
    if (!fs.statSync(realFile).isFile()) return false;
  } catch {
    return false;
  }
  return !blockedPlaces(home).some(place =>
    samePath(realFile, place) || isUnder(realFile, place) || isWithinDir(realFile, place));
}

export interface LandsOptions extends HomeCoverDeps {
  /** The dotfiles exception: one file link to a markdown file. Off unless asked for. */
  linkedMarkdown?: boolean;
}

/**
 * isUnderSafeRoot, and the target's real location under the real location of
 * one of `roots` that is not the home nor above it, or, when asked for, the
 * one exception above. `isInside(root, target)` is the caller's own test, by
 * spelling.
 */
export function landsUnderSafeRoot(target: string, roots: string[], isInside: Inside, deps: LandsOptions = {}): boolean {
  if (!isUnderSafeRoot(target, roots, isInside, deps)) return false;
  const real = realTarget(target);
  if (!real) return false;
  if (inRealRoot(target, real, roots, isInside, deps)) return true;
  if (deps.linkedMarkdown !== true) return false;
  // The exception. The folder the target sits in really lies in a root, so
  // only its last name can lead out: a file link (a folder link on the way
  // makes the parent's real path leave every root, and is refused here).
  const parent = path.dirname(target);
  const realParent = realTarget(parent);
  return !!realParent && inRealRoot(parent, realParent, roots, isInside, deps)
    && linkedFileAllowed(real, { home: deps.home });
}
