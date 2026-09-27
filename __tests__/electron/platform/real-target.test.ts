import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import { realTarget, landsUnderSafeRoot, isUnderSafeRoot, isUnder, samePath } from '../../../electron/platform';
import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * Where a read or a write of a path really lands, and whether that is under a root.
 *
 * fs:read-text-file, fs:write-text-file, fs:read-project-files and
 * local-file:// judged the path as SPELLED against their roots (DATA_DIR, the
 * projects), then readFileSync / writeFileSync followed every link on the
 * way. DATA_DIR is itself a root and every agent can write in it, so one
 * junction (`mklink /J %USERPROFILE%\.dorothy\h %USERPROFILE%`, or
 * `ln -s ~ ~/.dorothy/h`) opened the whole home, `~/.ssh` and
 * `~/.tars-private` included, to read and to write; a symlink inside a cloned
 * repository did the same. coversHome / isUnderSafeRoot look at the ROOTS,
 * never at where the target resolves.
 *
 * How it can fail, written before the code (2026-09-27):
 * 1. A link inside a root (a junction on win32, a symlink elsewhere) to the
 *    home, to `~/.ssh` or to `~/.tars-private` lets the target through: it is
 *    judged by its spelling.
 * 2. A symlinked FILE inside a root that points outside it lets it through.
 * 3. A link that stays inside its root, or leads into another allowed root,
 *    is refused: the check breaks legitimate links.
 * 4. A target that does not exist yet (a write that creates a file) is refused
 *    for having no real path, or is let through although its nearest existing
 *    parent's real path is outside every root.
 * 5. A dangling link in the target's place, or on the way to it, is let
 *    through: realpath fails, the folder above is inside, and the write follows
 *    the link and creates the file where it points.
 * 6. A root that is itself reached through a link (a project on a junctioned
 *    folder, a moved ~/.dorothy) refuses its own files: the real target is
 *    compared with the root's spelling, not its real location.
 * 7. win32: another case, a `\\?\` prefix or an 8.3 short name on the way
 *    reaches outside and is let through, or reaches inside and is refused.
 * 8. A root that is the home or above it, which the real target is under by
 *    spelling, lets the real target through: the real check must skip those
 *    roots too.
 * 9. A path that cannot be resolved (a loop of links) throws instead of
 *    being refused.
 * 10. A root that neither the target nor its real path is under, by spelling,
 *    is looked at on the disk (a stat on an offline share was measured at 21 s).
 */

const onWindows = process.platform === 'win32';
const linkDir = (to: string, at: string) => fs.symlinkSync(to, at, onWindows ? 'junction' : 'dir');
/** The callers' own test, by spelling, no I/O. */
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-real-target-')));
afterAll(() => { fs.rmSync(box, { recursive: true, force: true }); });

const home = path.join(box, 'home');
const ssh = path.join(home, '.ssh');
const priv = path.join(home, '.tars-private');
const data = path.join(home, '.dorothy');
const atlas = path.join(home, 'projects', 'atlas');
const docs = path.join(atlas, 'docs');
const outside = path.join(box, 'elsewhere');
const deps = { home };
const roots = [data, atlas];

fs.mkdirSync(ssh, { recursive: true });
fs.mkdirSync(priv, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(docs, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(ssh, 'id_rsa'), 'key');
fs.writeFileSync(path.join(priv, 'hermes-webhook-secret'), 'secret');
fs.writeFileSync(path.join(home, '.bashrc'), 'profile');
fs.writeFileSync(path.join(docs, 'a.md'), 'doc');
fs.writeFileSync(path.join(atlas, 'CLAUDE.md'), 'project');
linkDir(home, path.join(data, 'h'));
linkDir(ssh, path.join(data, 's'));
linkDir(priv, path.join(data, 'p'));
linkDir(ssh, path.join(atlas, 'escape'));
linkDir(docs, path.join(atlas, 'docs-link'));
linkDir(data, path.join(atlas, 'to-data'));

const lands = (target: string, r: string[] = roots) => landsUnderSafeRoot(target, r, inside, deps);

describe('1. a link inside a root that leads out of every root', () => {
  const escapes = [
    path.join(data, 'h', '.ssh', 'id_rsa'),
    path.join(data, 'h', '.bashrc'),
    path.join(data, 's', 'id_rsa'),
    path.join(data, 'p', 'hermes-webhook-secret'),
    path.join(atlas, 'escape', 'id_rsa'),
  ];

  it('is refused, although its spelling is under a root', () => {
    for (const target of escapes) {
      // The witness: the spelled check alone lets every one of them through.
      expect(isUnderSafeRoot(target, roots, inside, deps), target).toBe(true);
      expect(lands(target), target).toBe(false);
    }
  });
});

describe('2. a symlinked file inside a root', () => {
  it.skipIf(cannotSymlink())('pointing outside it is refused, pointing inside it is allowed', () => {
    const out = path.join(atlas, 'KEY.md');
    const inn = path.join(atlas, 'README.link.md');
    if (!fs.existsSync(out)) fs.symlinkSync(path.join(ssh, 'id_rsa'), out, 'file');
    if (!fs.existsSync(inn)) fs.symlinkSync(path.join(docs, 'a.md'), inn, 'file');
    expect(lands(out)).toBe(false);
    expect(lands(inn)).toBe(true);
  });
});

describe('3. a legitimate link', () => {
  it('that stays inside its root is allowed', () => {
    expect(lands(path.join(atlas, 'docs-link', 'a.md'))).toBe(true);
    expect(lands(path.join(atlas, 'CLAUDE.md'))).toBe(true);
  });

  it('that leads into another allowed root is allowed', () => {
    fs.writeFileSync(path.join(data, 'note.md'), 'n');
    expect(lands(path.join(atlas, 'to-data', 'note.md'))).toBe(true);
  });
});

describe('4. a target that does not exist yet', () => {
  it('is judged by its nearest existing folder: allowed inside', () => {
    expect(lands(path.join(atlas, 'new.md'))).toBe(true);
    expect(lands(path.join(atlas, 'docs-link', 'new.md'))).toBe(true);
    expect(lands(path.join(atlas, 'not-yet', 'deeper', 'new.md'))).toBe(true);
  });

  it('is refused when that folder really lies outside every root', () => {
    for (const target of [
      path.join(data, 's', 'authorized_keys'),
      path.join(data, 'h', 'new-profile'),
      path.join(data, 'p', 'new'),
      path.join(data, 's', 'not-yet', 'deeper', 'x'),
      path.join(atlas, 'escape', 'new'),
    ]) expect(lands(target), target).toBe(false);
  });

  it('realTarget names the real folder and keeps the missing tail', () => {
    expect(realTarget(path.join(atlas, 'docs-link', 'new.md'))).toBe(path.join(docs, 'new.md'));
    expect(realTarget(path.join(data, 's', 'x', 'y'))).toBe(path.join(ssh, 'x', 'y'));
  });
});

describe('5. a dangling link', () => {
  const gone = path.join(box, 'gone-dir');
  const dangling = path.join(atlas, 'dangling');
  fs.mkdirSync(gone, { recursive: true });
  linkDir(gone, dangling);
  fs.rmSync(gone, { recursive: true, force: true });

  it('in the target\'s place or on the way to it is refused', () => {
    expect(fs.existsSync(dangling)).toBe(false);
    expect(fs.lstatSync(dangling)).toBeTruthy();
    expect(realTarget(dangling)).toBeUndefined();
    expect(lands(dangling)).toBe(false);
    expect(lands(path.join(dangling, 'x.md'))).toBe(false);
  });

  it.skipIf(cannotSymlink())('a dangling file link is refused', () => {
    const file = path.join(atlas, 'dangling.md');
    if (!fs.existsSync(file)) fs.symlinkSync(path.join(home, '.new-profile'), file, 'file');
    expect(lands(file)).toBe(false);
  });
});

describe('6. a root reached through a link', () => {
  it('allows its own files, existing and new', () => {
    const realRoot = path.join(box, 'real-root');
    const linkedRoot = path.join(box, 'linked-root');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.writeFileSync(path.join(realRoot, 'f.md'), 'f');
    linkDir(realRoot, linkedRoot);
    expect(lands(path.join(linkedRoot, 'f.md'), [linkedRoot])).toBe(true);
    expect(lands(path.join(linkedRoot, 'new.md'), [linkedRoot])).toBe(true);
    // And the link inside it that leaves it is still refused.
    linkDir(ssh, path.join(realRoot, 'out'));
    expect(lands(path.join(linkedRoot, 'out', 'id_rsa'), [linkedRoot])).toBe(false);
  });
});

describe.skipIf(!onWindows)('7. win32 spellings', () => {
  /** The platform's own comparison, which reads `\\?\`, case and separators as Windows does. */
  const winInside = (root: string, target: string) => samePath(root, target) || isUnder(target, root);

  it('another case: an escape stays refused, a file inside stays allowed', () => {
    expect(lands(path.join(data, 'S', 'ID_RSA'))).toBe(false);
    expect(lands(path.join(atlas, 'DOCS-LINK', 'A.MD'))).toBe(true);
    expect(realTarget(path.join(atlas, 'DOCS-LINK', 'A.MD'))).toBe(path.join(docs, 'a.md'));
  });

  it('a \\\\?\\ prefix: resolved, then judged by where it lands', () => {
    const long = (p: string) => `\\\\?\\${p}`;
    expect(realTarget(long(path.join(atlas, 'docs-link', 'a.md')))).toBe(path.join(docs, 'a.md'));
    expect(landsUnderSafeRoot(long(path.join(data, 's', 'id_rsa')), roots, winInside, deps)).toBe(false);
    expect(landsUnderSafeRoot(long(path.join(data, 's', 'new')), roots, winInside, deps)).toBe(false);
    expect(landsUnderSafeRoot(long(path.join(atlas, 'CLAUDE.md')), roots, winInside, deps)).toBe(true);
  });

  /** The 8.3 name cmd.exe gives a path, or undefined where the volume makes none. */
  function shortName(p: string): string | undefined {
    // Verbatim: Node would otherwise escape the quotes as \" for a C program, which cmd.exe is not.
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
    return out && !samePath(out, p) ? out : undefined;
  }

  it('an 8.3 short name on the way: an escape stays refused, a file inside stays allowed', (ctx) => {
    const longLink = path.join(data, 'LongJunctionToSsh');
    const longDir = path.join(atlas, 'LongFolderName');
    if (!fs.existsSync(longLink)) linkDir(ssh, longLink);
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(path.join(longDir, 'f.md'), 'f');
    const shortLink = shortName(longLink);
    const shortDir = shortName(longDir);
    if (!shortLink || !shortDir) {
      console.warn(`skipped, 8.3 names: the volume under ${box} makes none (fsutil 8dot3name); runs where it does`);
      ctx.skip();
      return;
    }
    expect(lands(path.join(shortLink, 'id_rsa'), [data])).toBe(false);
    expect(landsUnderSafeRoot(path.join(shortDir, 'f.md'), [shortName(atlas) ?? atlas], inside, deps)).toBe(true);
  });
});

describe('8. a root that is the home or above it', () => {
  it('does not take the real target in', () => {
    // Spelled, the target is under atlas (safe) and the home (not): the
    // spelled check passes on atlas. Its real path is under the home only.
    const target = path.join(atlas, 'escape', 'id_rsa');
    expect(isUnderSafeRoot(target, [atlas, home], inside, deps)).toBe(true);
    expect(landsUnderSafeRoot(target, [atlas, home], inside, deps)).toBe(false);
  });
});

describe('9. a path that cannot be resolved', () => {
  it('is refused, and nothing throws', () => {
    const a = path.join(atlas, 'loop-a');
    const b = path.join(atlas, 'loop-b');
    fs.mkdirSync(b);
    linkDir(b, a);
    fs.rmdirSync(b);
    linkDir(a, b);
    expect(() => lands(path.join(a, 'x'))).not.toThrow();
    expect(lands(path.join(a, 'x'))).toBe(false);
    expect(lands(path.join(a, 'x', 'y'))).toBe(false);
  });
});

describe('10. a root neither the target nor its real path is under', () => {
  const OFFLINE = onWindows ? '\\\\tars-offline-nas.invalid\\share\\proj' : '/net/tars-offline-nas.invalid/proj';
  const nodeFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown> & { realpathSync: { native: unknown } };

  it('is never looked at on the disk', () => {
    const names = ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'readdirSync'];
    const saved = new Map(names.map(n => [n, nodeFs[n]]));
    const savedNative = nodeFs.realpathSync.native as (...args: unknown[]) => unknown;
    const touched: string[] = [];
    const record = (name: string, original: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      if (String(args[0]).startsWith(OFFLINE)) touched.push(`${name} ${String(args[0])}`);
      return original(...args);
    };
    for (const name of names) nodeFs[name] = record(name, saved.get(name) as (...args: unknown[]) => unknown);
    nodeFs.realpathSync.native = record('realpathSync.native', savedNative);
    syncBuiltinESMExports();
    try {
      expect(lands(path.join(atlas, 'CLAUDE.md'), [OFFLINE, atlas])).toBe(true);
      expect(lands(path.join(atlas, 'escape', 'id_rsa'), [OFFLINE, atlas])).toBe(false);
      expect(lands(path.join(atlas, 'new.md'), [OFFLINE, atlas])).toBe(true);
    } finally {
      for (const [name, original] of saved) nodeFs[name] = original;
      nodeFs.realpathSync.native = savedNative;
      syncBuiltinESMExports();
    }
    expect(touched).toEqual([]);
  });
});
