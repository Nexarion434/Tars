import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The `electron` a Tars server loads instead of Electron (tars-server, no
 * window, no display). The desktop never loads this file: it is installed by
 * electron/server/main.ts alone, through install-headless.ts.
 *
 * Why a module and not a host passed around: measured on upstream/main
 * (dc623b59), the core reaches 15 of the 46 files that import `electron`, and
 * calls only a handful of members inside functions, never at load; 136 test
 * files mock `electron` around those same modules. Answering `electron` here
 * keeps every one of those files, and the desktop, exactly as they are.
 *
 * What the core reaches means this without a window: the app is ready at
 * once and quits through the same before-quit listeners; there is no window
 * to find, make or focus; a notification is a line in the log (Telegram and
 * Hermes reach the phone); IPC handlers are accepted and never called. Any
 * other member fails by name when called, so a window-only path reached on a
 * server is a loud error, not a silent no-op.
 */

export interface HeadlessElectronOptions {
  /** The install root: where package.json, hooks/, skills/ and mcp-*\/dist live. */
  root: string;
  /** Started with --dev: isPackaged is false, as in a desktop dev run. */
  dev: boolean;
  log: (line: string) => void;
  exit: (code: number) => void;
}

interface QuitEvent { preventDefault(): void; defaultPrevented: boolean }

function unavailable(name: string): unknown {
  const refuse = (member: string) => () => {
    throw new Error(`A headless Tars has no ${name}: ${name}.${member} was called`);
  };
  return new Proxy(function unavailableMember() {}, {
    get: (_target, member) => (typeof member === 'string' ? refuse(member) : undefined),
    apply: () => refuse('call')(),
    construct: () => refuse('constructor')(),
  });
}

function stateHome(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state');
}

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
}

export function createHeadlessElectron(opts: HeadlessElectronOptions) {
  const version = String(JSON.parse(fs.readFileSync(path.join(opts.root, 'package.json'), 'utf-8')).version);
  const events = new EventEmitter();

  const paths: Record<string, () => string> = {
    home: () => os.homedir(),
    temp: () => os.tmpdir(),
    appData: () => configHome(),
    userData: () => path.join(stateHome(), 'tars-server'),
    logs: () => path.join(stateHome(), 'tars-server', 'logs'),
  };

  const emitQuitStep = (name: string): boolean => {
    const event: QuitEvent = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    events.emit(name, event);
    return event.defaultPrevented;
  };

  const app = {
    /** Read by host/headless.ts: this electron is the headless one. */
    headless: true as const,
    isPackaged: !opts.dev,
    getAppPath: () => opts.root,
    getPath(name: string): string {
      const resolve = paths[name];
      if (!resolve) throw new Error(`A headless Tars has no "${name}" path`);
      return resolve();
    },
    getVersion: () => version,
    getName: () => 'tars-server',
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on(event: string, listener: (...args: unknown[]) => void) { events.on(event, listener); return app; },
    once(event: string, listener: (...args: unknown[]) => void) { events.once(event, listener); return app; },
    removeListener(event: string, listener: (...args: unknown[]) => void) { events.removeListener(event, listener); return app; },
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    quit(): void {
      if (emitQuitStep('before-quit')) return;
      if (emitQuitStep('will-quit')) return;
      events.emit('quit');
      opts.exit(0);
    },
    exit: (code = 0) => opts.exit(code),
    focus: () => {},
    requestSingleInstanceLock: () => true,
    setAppUserModelId: () => {},
    dock: undefined,
  };

  class BrowserWindow {
    constructor() {
      throw new Error('A headless Tars has no window: new BrowserWindow() was called');
    }
    static getAllWindows(): never[] { return []; }
    static getFocusedWindow(): null { return null; }
    static fromWebContents(contents: unknown): null { void contents; return null; }
  }

  class Notification {
    constructor(private readonly note: { title?: string; body?: string } = {}) {}
    static isSupported(): boolean { return false; }
    show(): void { opts.log(`[notification] ${this.note.title ?? ''}: ${this.note.body ?? ''}`); }
    on(): this { return this; }
    close(): void {}
  }

  const ipcMain = {
    handle: () => {},
    handleOnce: () => {},
    removeHandler: () => {},
    on: () => ipcMain,
    once: () => ipcMain,
    removeListener: () => ipcMain,
    removeAllListeners: () => ipcMain,
  };

  return {
    app,
    BrowserWindow,
    Notification,
    ipcMain,
    dialog: unavailable('dialog'),
    shell: unavailable('shell'),
    Menu: unavailable('Menu'),
    MenuItem: unavailable('MenuItem'),
    Tray: unavailable('Tray'),
    protocol: unavailable('protocol'),
    screen: unavailable('screen'),
    clipboard: unavailable('clipboard'),
    nativeImage: unavailable('nativeImage'),
    powerSaveBlocker: unavailable('powerSaveBlocker'),
    safeStorage: unavailable('safeStorage'),
  };
}

export type HeadlessElectron = ReturnType<typeof createHeadlessElectron>;
