import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tars's data folder becomes ~/.tars (2.0.4, the maintainer's decision of
 * 18/10), from ~/.dorothy, at the start, once.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  D1. ~/.dorothy is copied (two folders, the old one going on being read or
 *      written), or a file is lost on the way, nested or not; the old path no
 *      longer reaches the data for what outside Tars still names it.
 *  D2. Stopped halfway, the next start moves it again, or leaves no way from
 *      the old path to the new one.
 *  D3. A start after the move changes anything.
 *  D4. The folder cannot be moved (a process holds it on Windows, a folder Tars
 *      may not write): Tars stops, or loses its data; it must go on from
 *      ~/.dorothy for this run, say why, and try again at the next start.
 *  D5. Both are real folders (an older Tars ran after the link was removed):
 *      one is merged into the other, or deleted; ~/.tars is used and
 *      ~/.dorothy left as it is, and said.
 *  D6. A first start with neither makes a link nobody needs.
 *  D7. ~/.dorothy is a link to another disk: what it points to is moved or
 *      copied, where only the link should be.
 *  D8. On Windows the link needs a privilege a user has not: it must be a
 *      junction.
 *  D9. ~/.tars is a file: it is written over.
 *  W1. The old path, written as Tars writes it into a file outside its folder
 *      (absolute, `~/.dorothy`, `$HOME/.dorothy`, `${HOME}/.dorothy`, JSON's
 *      escaped Windows path), is left there, or a name that only starts the
 *      same (`.dorothy-backup`) is changed; a file nothing changed in is
 *      written anyway, or loses its mode; a file not on the list is touched.
 */

import { settleDataDir, rewriteLegacyPaths } from '../../../electron/core/data-dir-move';

let home: string;
const tars = () => path.join(home, '.tars');
const old = () => path.join(home, '.dorothy');
const put = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.homedir(), 'move-'));
});

describe('the move', () => {
  it('D1. moves ~/.dorothy whole, and leaves a link at its old place', () => {
    put(path.join(old(), 'agents.json'), '[1]');
    put(path.join(old(), 'project-files', 'a-0123456789', 'reports', 'r.md'), '# r');
    put(path.join(old(), 'vault.db'), 'db');
    const inode = fs.statSync(path.join(old(), 'agents.json')).ino;
    const r = settleDataDir(home);
    expect(r).toMatchObject({ dir: tars(), did: 'moved', linked: true });
    expect(fs.lstatSync(tars()).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(tars(), 'agents.json')).ino).toBe(inode);
    expect(fs.readFileSync(path.join(tars(), 'project-files', 'a-0123456789', 'reports', 'r.md'), 'utf8')).toBe('# r');
    expect(fs.lstatSync(old()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(old(), 'vault.db'), 'utf8')).toBe('db');
    expect(fs.readdirSync(home).filter((n) => n.startsWith('.')).sort()).toEqual(['.dorothy', '.tars']);
  });

  it('D2, D3. stopped after the move, the next start makes the link; a start after that changes nothing', () => {
    put(path.join(old(), 'agents.json'), '[1]');
    fs.renameSync(old(), tars());
    expect(settleDataDir(home)).toMatchObject({ dir: tars(), did: 'already', linked: true });
    expect(fs.lstatSync(old()).isSymbolicLink()).toBe(true);
    const before = fs.lstatSync(old()).mtimeMs;
    expect(settleDataDir(home)).toMatchObject({ dir: tars(), did: 'already' });
    expect(fs.lstatSync(old()).mtimeMs).toBe(before);
    expect(fs.readFileSync(path.join(tars(), 'agents.json'), 'utf8')).toBe('[1]');
  });

  it('D4. a move refused leaves Tars on ~/.dorothy for this run, says why, and moves at the next start', () => {
    put(path.join(old(), 'agents.json'), '[1]');
    const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    const r = settleDataDir(home, { rename: () => { throw busy; } });
    expect(r).toMatchObject({ dir: old(), did: 'kept-old' });
    expect(r.why).toMatch(/EBUSY|busy/);
    expect(fs.existsSync(tars())).toBe(false);
    expect(settleDataDir(home)).toMatchObject({ dir: tars(), did: 'moved' });
  });

  it('D5. both real folders: ~/.tars used, ~/.dorothy left as it is, and said', () => {
    put(path.join(tars(), 'agents.json'), '[new]');
    put(path.join(old(), 'agents.json'), '[old]');
    const r = settleDataDir(home);
    expect(r).toMatchObject({ dir: tars(), did: 'both' });
    expect(r.why).toMatch(/\.dorothy/);
    expect(fs.readFileSync(path.join(old(), 'agents.json'), 'utf8')).toBe('[old]');
    expect(fs.readFileSync(path.join(tars(), 'agents.json'), 'utf8')).toBe('[new]');
  });

  it('D6. a first start makes no link', () => {
    expect(settleDataDir(home)).toMatchObject({ dir: tars(), did: 'none', linked: false });
    expect(fs.existsSync(old())).toBe(false);
  });

  it('D7. a ~/.dorothy that is a link to another disk: the link moves, what it points to stays', () => {
    const disk = path.join(home, 'Volumes', 'ext', 'dorothy');
    put(path.join(disk, 'agents.json'), '[ext]');
    fs.symlinkSync(disk, old());
    const r = settleDataDir(home);
    expect(r).toMatchObject({ dir: tars(), did: 'moved' });
    expect(fs.lstatSync(tars()).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(tars())).toBe(fs.realpathSync(disk));
    expect(fs.readFileSync(path.join(tars(), 'agents.json'), 'utf8')).toBe('[ext]');
    expect(fs.readFileSync(path.join(old(), 'agents.json'), 'utf8')).toBe('[ext]');
  });

  it('D8. on Windows the link is a junction', () => {
    put(path.join(old(), 'agents.json'), '[1]');
    const made: Array<[string, string, string | undefined]> = [];
    settleDataDir(home, { platform: 'win32', symlink: (target, at, type) => { made.push([target, at, type]); } });
    expect(made).toEqual([[tars(), old(), 'junction']]);
  });

  it('D9. a ~/.tars that is a file is not written over', () => {
    put(tars(), 'a file');
    put(path.join(old(), 'agents.json'), '[1]');
    const r = settleDataDir(home);
    expect(r).toMatchObject({ dir: old(), did: 'kept-old' });
    expect(fs.readFileSync(tars(), 'utf8')).toBe('a file');
  });
});

describe('W1. the old path, where Tars wrote it outside its folder', () => {
  it('is rewritten in every form Tars writes it, and nothing else is', () => {
    const abs = path.join(home, '.dorothy');
    const config = put(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { command: `bash ${abs}/statusline.sh` },
      mcpServers: { a: { command: `${abs}/bin/tars-mcp-node` } },
      backup: `${abs}-backup/x`, other: `${abs}X/y`,
    }, null, 2));
    fs.chmodSync(config, 0o600);
    const toml = put(path.join(home, '.codex', 'config.toml'), `command = "~/.dorothy/bin/tars-mcp-node"\nb = "$HOME/.dorothy/x"\nc = "\${HOME}/.dorothy"\n`);
    const win = put(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ c: 'C:\\Users\\u\\.dorothy\\bin\\tars-mcp-node.cmd' }));
    const untouched = put(path.join(home, '.claude', 'settings.json.notes'), `${abs}/kept`);
    const unchanged = put(path.join(home, '.grok', 'config.toml'), 'model = "grok"\n');
    const mtime = fs.statSync(unchanged).mtimeMs;
    const changed = rewriteLegacyPaths({ home, files: [config, toml, win, unchanged], winHome: 'C:\\Users\\u' });
    expect(changed.sort()).toEqual([config, toml, win].sort());
    const settings = JSON.parse(fs.readFileSync(config, 'utf8'));
    const nu = path.join(home, '.tars');
    expect(settings.statusLine.command).toBe(`bash ${nu}/statusline.sh`);
    expect(settings.mcpServers.a.command).toBe(`${nu}/bin/tars-mcp-node`);
    expect(settings.backup).toBe(`${abs}-backup/x`);
    expect(settings.other).toBe(`${abs}X/y`);
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(toml, 'utf8')).toBe('command = "~/.tars/bin/tars-mcp-node"\nb = "$HOME/.tars/x"\nc = "${HOME}/.tars"\n');
    expect(JSON.parse(fs.readFileSync(win, 'utf8')).c).toBe('C:\\Users\\u\\.tars\\bin\\tars-mcp-node.cmd');
    expect(fs.readFileSync(untouched, 'utf8')).toBe(`${abs}/kept`);
    expect(fs.statSync(unchanged).mtimeMs).toBe(mtime);
  });
});
