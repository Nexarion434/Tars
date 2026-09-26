import { describe, it, expect } from 'vitest';

import { isAbsolutePath, joinPath, pathName, pathTail, splitPath, tildePath, toSlashes } from '../../src/lib/display-path';

/**
 * How the renderer names and shortens a path it shows (audit B U-01, U-02,
 * U-04, U-05, U-07).
 *
 * Every site took `path.split('/').pop()` for a project's name and
 * `/^\/(Users|home)\/[^/]+/` for the `~`. A Windows path has no `/`, so the
 * Agents page, the Kanban cards, the chat rooms, the logs, the review page and
 * the pickers named every project by its whole `C:\Users\...` path, and none
 * was ever shortened to `~`.
 *
 * How it can fail, written before the code (2026-09-25):
 * 1. darwin/linux: anything changes. Every posix path gives what the old
 *    expression gave at its site, byte for byte, `\` in a file name included
 *    (the one exception, stated in 2, is a trailing `/`).
 * 2. A trailing separator gives an empty name instead of the folder's, as the
 *    main process's projectName (electron/platform/project-name.ts) already
 *    decided for the bots and the chat room titles; its table is mirrored.
 * 3. win32: `\` is not a separator, or `/` stops being one, and the whole path
 *    comes back as the name; a drive or share root comes back as a name.
 * 4. win32: the home is never shortened to `~`, or something else is: another
 *    drive's folder, the Users folder itself, or the home without the bare
 *    home option the chat head uses.
 * 5. win32: a tail of the path (the Projects page, the Super Agent sidebar)
 *    comes back whole, or joined with a separator the path does not use.
 * 6. win32: a file under a project gets a mixed `C:\p/src/x.ts` path in the
 *    Code panel, which is what it copies to the clipboard.
 * 7. A Windows absolute path is refused as a template folder on Windows, or
 *    accepted on macOS and Linux, where it names nothing.
 */

// The expressions the call sites used, kept here as the oracle for 1.
const old = {
  pop: (p: string) => p.split('/').pop(),
  lastNonEmpty: (p: string) => p.split('/').filter(Boolean).pop(),
  tilde: (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+\//, '~/'),
  chatTilde: (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~'),
  tail2: (p: string) => p.split('/').slice(-2).join('/'),
  join: (base: string, rel: string) => `${base}/${rel}`,
  absolute: (p: string) => p.startsWith('/'),
};

const POSIX = [
  '/Users/noah/Projects/tars',
  '/home/noah/tars',
  '/Users/noah',
  '/Users/noah/',
  '/Users/noah/atlas/',
  '/home/noah/atlas//',
  '/Users/Shared/tars',
  '/Users/noah/a\\b',
  '/Users/noah/C:\\x',
  "/Users/noah/o'neil proj (x86)/app",
  '/Users/noah/.claude/CLAUDE.md',
  '/opt/work/tars',
  '//server/share/tars',
  '/a//b',
  '/',
  '',
  'relative/name',
  'name',
];

describe('display-path on darwin and linux paths (1, 2)', () => {
  it('names a path as split(/).pop() did, and a trailing / as filter(Boolean).pop() did', () => {
    for (const p of POSIX) {
      expect(pathName(p), p).toBe(old.lastNonEmpty(p) ?? '');
      if (!p.endsWith('/')) expect(pathName(p), p).toBe(old.pop(p));
    }
  });

  it('shortens the home to ~ exactly as both old expressions did', () => {
    for (const p of POSIX) {
      expect(tildePath(p), p).toBe(old.tilde(p));
      expect(tildePath(p, { bareHome: true }), p).toBe(old.chatTilde(p));
    }
  });

  it('splits, tails, joins and slashes a path as the old code did', () => {
    for (const p of POSIX) {
      expect(splitPath(p), p).toEqual({ parts: p.split('/'), sep: '/' });
      expect(pathTail(p, 2), p).toBe(old.tail2(p));
      expect(joinPath(p, 'src/app/x.ts'), p).toBe(old.join(p, 'src/app/x.ts'));
      expect(toSlashes(p), p).toBe(p);
    }
  });

  it('calls absolute what starts with / and nothing else, Windows paths included (7)', () => {
    for (const platform of ['darwin', 'linux']) {
      for (const p of [...POSIX, 'C:\\Users\\nicol\\vault', 'C:/vault', '\\\\srv\\share', '~/x', ' /x']) {
        expect(isAbsolutePath(p, platform), `${platform} ${p}`).toBe(old.absolute(p));
      }
    }
  });
});

describe('display-path on Windows paths', () => {
  it('3. names the last folder, with either separator', () => {
    expect(pathName('C:\\Users\\nicol\\projects\\tars')).toBe('tars');
    expect(pathName('C:/Users/nicol/projects/tars')).toBe('tars');
    expect(pathName("C:\\Users\\nicol/projects\\o'neil proj (x86)")).toBe("o'neil proj (x86)");
    expect(pathName('\\\\server\\share\\team\\atlas')).toBe('atlas');
    expect(pathName('D:\\work\\src\\app\\page.tsx')).toBe('page.tsx');
  });

  it('2. drops a trailing separator', () => {
    expect(pathName('C:\\Users\\nicol\\atlas\\')).toBe('atlas');
    expect(pathName('C:\\Users\\nicol\\atlas\\\\')).toBe('atlas');
    expect(pathName('C:/Users/nicol/atlas/')).toBe('atlas');
  });

  it('3. names no root', () => {
    for (const root of ['C:\\', 'C:/', 'C:', '\\', '\\\\server\\share\\', '\\\\server\\share']) expect(pathName(root), root).toBe('');
  });

  it('4. shortens the home under a drive\'s Users folder to ~, keeping the separator written', () => {
    expect(tildePath('C:\\Users\\nicol\\projects\\tars')).toBe('~\\projects\\tars');
    expect(tildePath('c:\\users\\nicol\\projects\\tars')).toBe('~\\projects\\tars');
    expect(tildePath('D:/Users/nicol/work')).toBe('~/work');
    expect(tildePath('C:\\Users\\nicol\\')).toBe('~\\');
  });

  it('4. leaves the rest alone, and the bare home to the chat head', () => {
    for (const p of ['C:\\Users\\nicol', 'C:\\Users', 'C:\\Users\\', 'D:\\work\\tars', 'C:\\Program Files\\Users\\x\\y', '\\\\srv\\Users\\x\\y']) {
      expect(tildePath(p), p).toBe(p);
    }
    expect(tildePath('C:\\Users\\nicol', { bareHome: true })).toBe('~');
    expect(tildePath('C:\\Users\\nicol\\atlas', { bareHome: true })).toBe('~\\atlas');
  });

  it('5. splits on both separators and joins a tail with the one the path uses', () => {
    expect(splitPath('C:\\Users\\nicol\\projects\\tars')).toEqual({ parts: ['C:', 'Users', 'nicol', 'projects', 'tars'], sep: '\\' });
    expect(splitPath('C:/a/b').parts).toHaveLength(3);
    expect(pathTail('C:\\Users\\nicol\\projects\\tars', 2)).toBe('projects\\tars');
    expect(pathTail('C:/Users/nicol/projects/tars', 2)).toBe('projects/tars');
  });

  it('6. joins a /-separated relative path under a project with the project\'s separator', () => {
    expect(joinPath('C:\\Users\\nicol\\tars', 'src/app/x.ts')).toBe('C:\\Users\\nicol\\tars\\src\\app\\x.ts');
    expect(joinPath('C:/Users/nicol/tars', 'src/app/x.ts')).toBe('C:/Users/nicol/tars/src/app/x.ts');
  });

  it('turns a Windows path\'s backslashes into slashes, and nothing else', () => {
    expect(toSlashes('C:\\p\\.claude\\CLAUDE.md')).toBe('C:/p/.claude/CLAUDE.md');
    expect(toSlashes('\\\\srv\\share\\x')).toBe('//srv/share/x');
  });

  it('7. calls absolute on win32 what Windows does: a drive, a share, a rooted path', () => {
    for (const p of ['C:\\Users\\nicol\\vault', 'C:/vault', 'c:\\x', '\\\\srv\\share\\x', '/Users/noah/vault', '\\x']) {
      expect(isAbsolutePath(p, 'win32'), p).toBe(true);
    }
    for (const p of ['C:x', 'C:', 'vault\\x', '~\\vault', '~/vault', '', ' C:\\x', './x']) {
      expect(isAbsolutePath(p, 'win32'), p).toBe(false);
    }
  });
});
