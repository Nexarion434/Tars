import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHeadlessElectron } from '../../../electron/host/headless-electron';
import { installHeadlessElectron } from '../../../electron/host/install-headless';

/**
 * The `electron` a Tars server loads instead of Electron: the members the core
 * reaches (measured on upstream/main dc623b59: app, BrowserWindow, Notification,
 * ipcMain), each with what it means without a window, and every other member
 * failing by name when called. The desktop never loads it.
 *
 * How it fails:
 * - userData somewhere other than $XDG_STATE_HOME/tars-server, or a relative
 *   XDG_STATE_HOME used (the XDG spec makes it invalid), or an unknown
 *   getPath name answered with a guess instead of an error naming it
 * - isPackaged false on a server not started with --dev, which would let a
 *   server read the overrides a packaged Tars refuses
 * - getVersion read from anywhere but the install root's package.json
 * - a before-quit listener not run by quit(), run twice, or a quit that
 *   exits although a listener prevented it (the shutdown steps do)
 * - a window found, made, or focused: getAllWindows not empty, fromWebContents
 *   not null, `new BrowserWindow()` not refused
 * - a notification that throws or leaves no line in the log
 * - dialog, shell, Menu, protocol, Tray, screen, clipboard answering instead
 *   of failing with the member's name
 * - the install hook not answering `require('electron')` with this module,
 *   installed twice, or left behind by its uninstall
 */

function root(version = '9.8.7'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-root-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tars', version }));
  return dir;
}

function make(opts: { dev?: boolean; exit?: (code: number) => void } = {}) {
  const lines: string[] = [];
  const exits: number[] = [];
  const electron = createHeadlessElectron({
    root: root(),
    dev: opts.dev ?? false,
    log: line => lines.push(line),
    exit: opts.exit ?? (code => exits.push(code)),
  });
  return { electron, lines, exits };
}

const savedXdg = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdg;
});

describe('the headless app', () => {
  it('keeps userData under an absolute XDG_STATE_HOME', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-'));
    process.env.XDG_STATE_HOME = state;
    expect(make().electron.app.getPath('userData')).toBe(path.join(state, 'tars-server'));
  });

  it('ignores a relative XDG_STATE_HOME and falls back to ~/.local/state', () => {
    process.env.XDG_STATE_HOME = 'relative/state';
    expect(make().electron.app.getPath('userData')).toBe(path.join(os.homedir(), '.local', 'state', 'tars-server'));
  });

  it('answers home and temp, and refuses a name it does not know', () => {
    const { app } = make().electron;
    expect(app.getPath('home')).toBe(os.homedir());
    expect(app.getPath('temp')).toBe(os.tmpdir());
    expect(() => app.getPath('desktop')).toThrow(/desktop/);
  });

  it('is packaged unless started with --dev', () => {
    expect(make().electron.app.isPackaged).toBe(true);
    expect(make({ dev: true }).electron.app.isPackaged).toBe(false);
  });

  it('reads its version from the install root and names itself tars-server', () => {
    const dir = root('1.2.3');
    const electron = createHeadlessElectron({ root: dir, dev: false, log: () => {}, exit: () => {} });
    expect(electron.app.getVersion()).toBe('1.2.3');
    expect(electron.app.getName()).toBe('tars-server');
    expect(electron.app.getAppPath()).toBe(dir);
  });

  it('is ready at once', async () => {
    const { app } = make().electron;
    expect(app.isReady()).toBe(true);
    await expect(app.whenReady()).resolves.toBeUndefined();
  });

  it('runs before-quit listeners once, then exits 0', () => {
    const { electron, exits } = make();
    let ran = 0;
    electron.app.once('before-quit', () => { ran++; });
    electron.app.quit();
    electron.app.quit();
    expect(ran).toBe(1);
    expect(exits).toEqual([0, 0]);
  });

  it('does not exit when a before-quit listener prevents it', () => {
    const { electron, exits } = make();
    electron.app.once('before-quit', (event: { preventDefault(): void }) => event.preventDefault());
    electron.app.quit();
    expect(exits).toEqual([]);
    electron.app.exit(3);
    expect(exits).toEqual([3]);
  });
});

describe('no window', () => {
  it('finds none and makes none', () => {
    const { BrowserWindow } = make().electron;
    expect(BrowserWindow.getAllWindows()).toEqual([]);
    expect(BrowserWindow.getFocusedWindow()).toBeNull();
    expect(BrowserWindow.fromWebContents({})).toBeNull();
    expect(() => new BrowserWindow()).toThrow(/headless/);
  });

  it('writes a notification to the log', () => {
    const { electron, lines } = make();
    expect(electron.Notification.isSupported()).toBe(false);
    expect(() => new electron.Notification({ title: 'Agent done', body: 'Nova finished' }).show()).not.toThrow();
    expect(lines.join('\n')).toMatch(/Agent done.*Nova finished/);
  });

  it('accepts IPC handlers that nothing will call', () => {
    const { ipcMain } = make().electron;
    expect(() => ipcMain.handle('orchestrator:getStatus', async () => ({}))).not.toThrow();
    expect(() => ipcMain.on('x', () => {})).not.toThrow();
    expect(() => ipcMain.removeHandler('orchestrator:getStatus')).not.toThrow();
  });

  it.each([
    ['dialog', 'showMessageBox'],
    ['shell', 'openExternal'],
    ['Menu', 'buildFromTemplate'],
    ['protocol', 'handle'],
    ['Tray', 'constructor'],
    ['screen', 'getPrimaryDisplay'],
    ['clipboard', 'writeText'],
  ])('fails by name on %s.%s', (name, member) => {
    const electron = make().electron as unknown as Record<string, Record<string, () => unknown>>;
    const call = () => (member === 'constructor' ? new (electron[name] as unknown as new () => unknown)() : electron[name][member]());
    expect(call).toThrow(new RegExp(`headless.*${name}`));
  });
});

describe('installHeadlessElectron', () => {
  it("answers require('electron') with the headless module until uninstalled", () => {
    const electron = make().electron;
    const uninstall = installHeadlessElectron(electron);
    try {
      const req = createRequire(__filename);
      expect(req('electron')).toBe(electron);
      expect(() => installHeadlessElectron(electron)).toThrow(/already/);
    } finally {
      uninstall();
    }
    expect(createRequire(__filename).resolve('electron')).toMatch(/node_modules[\\/]electron/);
  });
});
