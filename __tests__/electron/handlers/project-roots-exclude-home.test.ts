import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * No project root opens the home (security, every platform).
 *
 * fs:read-text-file and fs:write-text-file take the projects the user added
 * as roots; fs:read-project-files takes those, the agents' folders and the
 * folders Claude has seen; local-file:// takes the added projects. None of
 * them looked at what the project was: a project equal to the home, or any
 * folder above it (`C:\Users`, `/Users`, `/`), made every file of the home
 * readable, and through fs:write-text-file writable (a shell profile, an SSH
 * key, the Windows Startup folder). One call from the renderer, or one line
 * in projects.json, which every agent can write (it is under ~/.dorothy).
 *
 * How it can fail, written before the fix (2026-09-25):
 * 1. fs:read-text-file reads a file of the home through a project that is the
 *    home, an ancestor of it, or on win32 the home in another case, with `/`
 *    or a trailing separator.
 * 2. fs:write-text-file writes one the same ways.
 * 3. fs:read-project-files reads one through such a project, or through an
 *    agent whose folder is the home.
 * 4. local-file:// serves one through such a project.
 * 5. The same through a link to the home: a junction on win32, a symlink
 *    elsewhere.
 * 6. A project under the home is refused: the guard breaks the Brain page.
 *
 * Added at win-reviewer's re-review (2026-09-25), written before the fix:
 * 7. A project the target is not under is looked at on the disk anyway: one
 *    project on an offline share (statSync measured at 21 s) froze every read
 *    and write of every other project, on the main thread.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.0', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: (scheme: string, handler: unknown) => { protocols.set(scheme, handler as Protocol); }, registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type Protocol = (request: { url: string }) => Promise<Response>;
const handlers = new Map<string, Handler>();
const protocols = new Map<string, Protocol>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { setupProtocolHandler } from '../../../electron/core/window-manager';
import { DATA_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const onWindows = process.platform === 'win32';
const agents = new Map<string, AgentStatus>();

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, getClaudeSkills: async () => [] };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts).
const home = os.homedir();
const SECRET = 'secret-of-the-home.txt';
const project = path.join(home, 'projects', 'atlas');
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-roots-')));
const junction = path.join(box, 'to-home');

/** The home, spelled every way the platform takes as the home, and the folders above it. */
function homeCovers(): string[] {
  const spellings = [home, home + path.sep, path.dirname(home)];
  if (onWindows) spellings.push(home.toLowerCase(), home.toUpperCase(), home.replace(/\\/g, '/'), path.parse(home).root);
  else spellings.push('/');
  return spellings;
}

function customProjects(list: string[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(list));
}

beforeEach(() => {
  handlers.clear();
  agents.clear();
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, SECRET), 'the home');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'a project file');
  if (!fs.existsSync(junction)) fs.symlinkSync(home, junction, onWindows ? 'junction' : 'dir');
  registerIpcHandlers(deps());
});

afterAll(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

const readText = (file: string) => handlers.get('fs:read-text-file')!({}, file) as Promise<{ content: string; error?: string }>;
const writeText = (file: string, content: string) => handlers.get('fs:write-text-file')!({}, { filePath: file, content }) as Promise<{ success: boolean; error?: string }>;

describe('fs:read-text-file and fs:write-text-file', () => {
  it('1, 2. refuse the home\'s files through the home or a folder above it, however spelled', async () => {
    for (const root of homeCovers()) {
      customProjects([project, root]);
      const file = path.join(home, SECRET);
      expect((await readText(file)).content, `read through ${root}`).toBe('');
      expect((await writeText(file, 'overwritten')).success, `write through ${root}`).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('the home');
    }
  });

  it('5. refuse them through a link to the home', async () => {
    customProjects([project, junction]);
    const file = path.join(junction, SECRET);
    expect((await readText(file)).content).toBe('');
    expect((await writeText(file, 'overwritten')).success).toBe(false);
    expect(fs.readFileSync(path.join(home, SECRET), 'utf8')).toBe('the home');
  });

  it('6. still read and write a project under the home', async () => {
    customProjects([project, path.dirname(home)]);
    expect((await readText(path.join(project, 'CLAUDE.md'))).content).toBe('a project file');
    expect((await writeText(path.join(project, 'CLAUDE.md'), 'edited')).success).toBe(true);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('edited');
  });
});

describe('fs:read-project-files', () => {
  const read = (base: string, rel: string) =>
    handlers.get('fs:read-project-files')!({}, { paths: [base], relative: [rel] }) as Promise<{ files: Record<string, string> }>;

  it('3. refuses the home\'s files through a project that is the home or above it', async () => {
    for (const root of homeCovers()) {
      customProjects([root]);
      expect((await read(root, path.relative(root, path.join(home, SECRET)))).files, root).toEqual({});
      expect((await read(home, SECRET)).files, `${root}, base home`).toEqual({});
    }
  });

  it('3. refuses them through an agent whose folder is the home', async () => {
    customProjects([]);
    agents.set('a1', { id: 'a1', projectPath: home, worktreePath: path.dirname(home) } as AgentStatus);
    expect((await read(home, SECRET)).files).toEqual({});
  });

  it('5. refuses them through a link to the home', async () => {
    customProjects([junction]);
    expect((await read(junction, SECRET)).files).toEqual({});
  });

  it('6. still reads a project under the home', async () => {
    customProjects([project, home]);
    expect(Object.values((await read(project, 'CLAUDE.md')).files)).toEqual(['a project file']);
  });
});

// Not on win32: there local-file:// serves no file at all. It resolves the
// URL's pathname, `/C:/Users/...`, to `C:\C:\Users\...`, which is under no
// root, so every request is a 403 (measured 2026-09-25; the renderer uses
// /api/local-file instead). Run on macOS and Linux, where it serves files.
describe.skipIf(onWindows)('local-file://', () => {
  beforeEach(() => {
    protocols.clear();
    setupProtocolHandler();
  });
  const serve = async (file: string) => {
    const url = new URL('local-file://');
    url.pathname = file.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1');
    return (await protocols.get('local-file')!({ url: url.href })).status;
  };

  it('4. refuses the home\'s files through a project that is the home or above it', async () => {
    for (const root of homeCovers()) {
      customProjects([root]);
      expect(await serve(path.join(home, SECRET)), root).toBe(403);
    }
  });

  it('5. refuses them through a link to the home', async () => {
    customProjects([junction]);
    expect(await serve(path.join(junction, SECRET))).toBe(403);
  });

  it('6. still serves a project under the home', async () => {
    customProjects([project, home]);
    expect(await serve(path.join(project, 'CLAUDE.md'))).toBe(200);
  });
});

describe('a project root the target is not under', () => {
  // A share nobody answers for: statSync on one was measured at 21 s.
  const OFFLINE = onWindows ? '\\\\tars-offline-nas.invalid\\share\\proj' : '/net/tars-offline-nas.invalid/proj';
  const nodeFs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;

  /** Runs `fn` with every fs call that takes a path recorded when the path is on the offline share. */
  async function touchesOffline(fn: () => Promise<unknown>): Promise<string[]> {
    const names = ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'realpathSync', 'readdirSync', 'stat', 'lstat', 'access'];
    const saved = new Map(names.map(n => [n, nodeFs[n]]));
    const touched: string[] = [];
    for (const name of names) {
      const original = saved.get(name) as (...args: unknown[]) => unknown;
      const wrapped = Object.assign((...args: unknown[]) => {
        if (String(args[0]).startsWith(OFFLINE)) touched.push(`${name} ${String(args[0])}`);
        return original(...args);
      }, original);
      nodeFs[name] = wrapped;
    }
    syncBuiltinESMExports();
    try {
      await fn();
    } finally {
      for (const [name, original] of saved) nodeFs[name] = original;
      syncBuiltinESMExports();
    }
    return touched;
  }

  it('7. is never looked at when reading and writing under another project', { timeout: 120_000 }, async () => {
    customProjects([OFFLINE, project]);
    const touched = await touchesOffline(async () => {
      expect((await readText(path.join(project, 'CLAUDE.md'))).content).toBe('a project file');
      expect((await writeText(path.join(project, 'CLAUDE.md'), 'a project file')).success).toBe(true);
      const files = await handlers.get('fs:read-project-files')!({}, { paths: [project], relative: ['CLAUDE.md'] }) as { files: Record<string, string> };
      expect(Object.values(files.files)).toEqual(['a project file']);
    });
    expect(touched).toEqual([]);
  });
});
