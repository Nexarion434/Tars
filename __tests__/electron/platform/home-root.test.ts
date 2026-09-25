import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { coversHome, withoutHomeCover, pathKey, isUnderSafeRoot } from '../../../electron/platform';

/**
 * Whether a folder the app takes as a project root is the home, or holds it.
 *
 * The file handlers that read and write under "a project" (fs:read-text-file,
 * fs:write-text-file, fs:read-project-files, local-file://) took any project
 * the user added, or an agent's folder, as a root. A project equal to the home,
 * or any folder above it (`C:\Users`, `/Users`, `/`), made every file of the
 * home readable, and for fs:write-text-file writable: `.bashrc`, `.ssh`, the
 * Startup folder. On every platform.
 *
 * How it can fail, written before the code (2026-09-25):
 * 1. The home itself is not caught, spelled as the platform spells it, with a
 *    trailing separator, or on win32 in another case or with `/`.
 * 2. An ancestor of the home (`C:\Users`, `C:\`, `/Users`, `/`) is not caught,
 *    in the same spellings.
 * 3. A folder that is another name for the home or an ancestor (a junction on
 *    win32, a symlink elsewhere, a case-insensitive volume on macOS) is not
 *    caught: only its spelling is compared.
 * 4. A project under the home, a sibling of the home sharing its prefix
 *    (`C:\Users\nicolas` beside `C:\Users\nicol`), or a folder on another
 *    branch is caught: the check refuses legitimate projects.
 * 5. A root that does not exist, or a home that cannot be read, throws.
 * 6. win32: a file system that reports no file id (ino 0) makes every folder
 *    on it look like the home.
 * 7. pathKey: two spellings samePath takes as one give two keys, or two
 *    folders give one.
 *
 * Added at win-reviewer's re-review (2026-09-25), written before the fix:
 * 8. The home is itself a link (a relocated profile junction, /home symlinked
 *    to /data/home): the folders above its REAL location are not caught, and
 *    open the whole home.
 * 9. Judging a set of roots stats a root the target is not under: one project
 *    on an unreachable share (statSync measured at 21 s) freezes every call.
 *    Only the roots the target is under by spelling may be stat'ed.
 * 10. The target under a legitimate root is refused, or allowed under a root
 *    that covers the home.
 */

const made: string[] = [];
afterAll(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

describe('coversHome, by spelling', () => {
  const WIN_HOME = 'C:\\Users\\nicol';
  const POSIX_HOME = '/Users/noah';
  const noStat = () => undefined;

  it('1. the home, however win32 spells it', () => {
    for (const p of [WIN_HOME, 'c:\\users\\NICOL', 'C:/Users/nicol', 'C:\\Users\\nicol\\', 'C:\\Users\\nicol\\.']) {
      expect(coversHome(p, { home: WIN_HOME, platform: 'win32', stat: noStat }), p).toBe(true);
    }
  });

  it('1. the home on darwin and linux, trailing slash included', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const p of [POSIX_HOME, `${POSIX_HOME}/`, `${POSIX_HOME}//`]) {
        expect(coversHome(p, { home: POSIX_HOME, platform, stat: noStat }), p).toBe(true);
      }
    }
  });

  it('2. every folder above the home', () => {
    for (const p of ['C:\\Users', 'c:/users/', 'C:\\', 'C:', 'C:/']) {
      expect(coversHome(p, { home: WIN_HOME, platform: 'win32', stat: noStat }), p).toBe(true);
    }
    for (const platform of ['darwin', 'linux'] as const) {
      for (const p of ['/Users', '/Users/', '/']) expect(coversHome(p, { home: POSIX_HOME, platform, stat: noStat }), p).toBe(true);
    }
  });

  it('4. a project under the home, a sibling sharing its prefix, another branch: not the home', () => {
    for (const p of ['C:\\Users\\nicol\\projects\\atlas', 'C:\\Users\\nicolas', 'D:\\', 'C:\\Program Files', '']) {
      expect(coversHome(p, { home: WIN_HOME, platform: 'win32', stat: noStat }), p).toBe(false);
    }
    for (const platform of ['darwin', 'linux'] as const) {
      for (const p of ['/Users/noah/atlas', '/Users/noahx', '/opt', '']) expect(coversHome(p, { home: POSIX_HOME, platform, stat: noStat }), p).toBe(false);
    }
  });

  it('3. another name for the home or an ancestor: the same file id', () => {
    const ids: Record<string, { dev: bigint; ino: bigint }> = {
      'C:\\Users\\nicol': { dev: 7n, ino: 100n },
      'C:\\Users': { dev: 7n, ino: 50n },
      'C:\\': { dev: 7n, ino: 5n },
      'D:\\to-home': { dev: 7n, ino: 100n },
      'D:\\to-users': { dev: 7n, ino: 50n },
      'D:\\elsewhere': { dev: 7n, ino: 999n },
    };
    const stat = (p: string) => ids[p];
    expect(coversHome('D:\\to-home', { home: WIN_HOME, platform: 'win32', stat })).toBe(true);
    expect(coversHome('D:\\to-users', { home: WIN_HOME, platform: 'win32', stat })).toBe(true);
    expect(coversHome('D:\\elsewhere', { home: WIN_HOME, platform: 'win32', stat })).toBe(false);
  });

  it('6. a file id of 0 is no file id', () => {
    const stat = () => ({ dev: 7n, ino: 0n });
    expect(coversHome('E:\\stick\\project', { home: WIN_HOME, platform: 'win32', stat })).toBe(false);
  });

  it('5. a root or a home that cannot be read is judged by spelling, and nothing throws', () => {
    const stat = () => { throw new Error('EACCES'); };
    expect(() => coversHome('C:\\x', { home: WIN_HOME, platform: 'win32', stat })).not.toThrow();
    expect(coversHome('C:\\x', { home: WIN_HOME, platform: 'win32', stat })).toBe(false);
    expect(coversHome('C:\\Users', { home: WIN_HOME, platform: 'win32', stat })).toBe(true);
  });

  it('withoutHomeCover keeps the order of the roots it keeps', () => {
    expect(withoutHomeCover(['C:\\a', 'C:\\Users', 'C:\\Users\\nicol\\b', 'c:\\users\\nicol'], { home: WIN_HOME, platform: 'win32', stat: noStat }))
      .toEqual(['C:\\a', 'C:\\Users\\nicol\\b']);
  });
});

describe('coversHome, on this disk', () => {
  it('3. a link to the home is the home (a junction on win32, a symlink elsewhere)', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-root-')));
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-link-')));
    made.push(home, box);
    fs.mkdirSync(path.join(home, 'projects', 'atlas'), { recursive: true });
    const link = path.join(box, 'to-home');
    fs.symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir');
    const parentLink = path.join(box, 'to-parent');
    fs.symlinkSync(path.dirname(home), parentLink, process.platform === 'win32' ? 'junction' : 'dir');

    expect(coversHome(link, { home })).toBe(true);
    expect(coversHome(parentLink, { home })).toBe(true);
    expect(coversHome(path.join(home, 'projects', 'atlas'), { home })).toBe(false);
    expect(coversHome(box, { home })).toBe(false);
  });
});

describe('pathKey', () => {
  it('7. one key for the spellings samePath takes as one, two for two folders', () => {
    expect(pathKey('C:\\Repo\\', 'win32')).toBe(pathKey('c:/repo', 'win32'));
    expect(pathKey('C:\\repo', 'win32')).not.toBe(pathKey('C:\\repo2', 'win32'));
    expect(pathKey('/a/Repo/', 'darwin')).toBe(pathKey('/a/Repo', 'darwin'));
    expect(pathKey('/a/Repo', 'linux')).not.toBe(pathKey('/a/repo', 'linux'));
  });
});

describe('8. a home that is itself a link', () => {
  it('refuses the folders above the real home, however they are reached', () => {
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-moved-')));
    made.push(box);
    const realHome = path.join(box, 'data', 'Users', 'nicol');
    fs.mkdirSync(path.join(realHome, 'projects', 'atlas'), { recursive: true });
    fs.mkdirSync(path.join(box, 'data', 'Other'), { recursive: true });
    const home = path.join(box, 'profile-link');
    fs.symlinkSync(realHome, home, process.platform === 'win32' ? 'junction' : 'dir');
    const realParent = path.dirname(realHome);
    const realGrandparent = path.dirname(realParent);

    const spellings = [realParent, realGrandparent];
    if (process.platform === 'win32') {
      spellings.push(`\\\\?\\${realParent}`);
      const adminShare = `\\\\localhost\\${realParent[0]}$${realParent.slice(2)}`;
      try { fs.statSync(adminShare); spellings.push(adminShare); } catch { /* no admin share on this machine: nothing to check */ }
    }
    for (const root of spellings) expect(coversHome(root, { home }), root).toBe(true);
    expect(coversHome(realHome, { home })).toBe(true);
    expect(coversHome(path.join(realHome, 'projects', 'atlas'), { home })).toBe(false);
    expect(coversHome(path.join(box, 'data', 'Other'), { home })).toBe(false);
  });

  it('refuses them by id when only the real path names them (injected)', () => {
    const ids: Record<string, { dev: bigint; ino: bigint }> = {
      'C:\\Users\\nicol': { dev: 1n, ino: 10n },
      'C:\\Users': { dev: 1n, ino: 5n },
      'D:\\data\\Users\\nicol': { dev: 1n, ino: 10n },
      'D:\\data\\Users': { dev: 2n, ino: 50n },
      'D:\\data': { dev: 2n, ino: 40n },
      'E:\\to-real-parent': { dev: 2n, ino: 50n },
    };
    const deps = { home: 'C:\\Users\\nicol', platform: 'win32' as const, stat: (p: string) => ids[p], realpath: () => 'D:\\data\\Users\\nicol' };
    expect(coversHome('D:\\data\\Users', deps)).toBe(true);
    expect(coversHome('D:\\data', deps)).toBe(true);
    expect(coversHome('E:\\to-real-parent', deps)).toBe(true);
    expect(coversHome('D:\\data\\Users\\nicol\\atlas', deps)).toBe(false);
  });
});

describe('isUnderSafeRoot', () => {
  const HOME = 'C:\\Users\\nicol';
  const inside = (root: string, target: string) => target === root || target.startsWith(`${root}\\`);

  it('9, 10. stats only the roots the target is under, and allows it under a legitimate one', () => {
    const statted: string[] = [];
    const stat = (p: string) => { statted.push(p); return { dev: 1n, ino: BigInt(statted.length + 100) }; };
    const roots = ['\\\\offline-nas\\share\\proj', 'C:\\Users\\nicol\\projects\\atlas'];

    const allowed = isUnderSafeRoot('C:\\Users\\nicol\\projects\\atlas\\CLAUDE.md', roots, inside, { home: HOME, platform: 'win32', stat, realpath: (p: string) => p });

    expect(allowed).toBe(true);
    expect(statted.filter(p => p.startsWith('\\\\offline-nas'))).toEqual([]);
  });

  it('10. refuses a target whose only root covers the home, and one under no root', () => {
    const stat = () => undefined;
    expect(isUnderSafeRoot('C:\\Users\\nicol\\.ssh\\id_rsa', ['C:\\Users'], inside, { home: HOME, platform: 'win32', stat })).toBe(false);
    expect(isUnderSafeRoot('D:\\x', ['C:\\a'], inside, { home: HOME, platform: 'win32', stat })).toBe(false);
  });
});
