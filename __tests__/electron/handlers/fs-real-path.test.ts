import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cannotSymlink } from '../../setup/symlink-privilege';

/**
 * The file handlers judge where a path really lands, not how it is spelled
 * (security, every platform).
 *
 * fs:read-text-file, fs:write-text-file, fs:read-project-files and
 * local-file:// checked the path as spelled against their roots, then
 * readFileSync / writeFileSync / readFile followed the links on the way.
 * ~/.dorothy is a root of three of them and every agent is handed it, so
 * `ln -s ~ ~/.dorothy/h` (`mklink /J` on Windows, no privilege needed) opened
 * the whole home, ~/.ssh and ~/.tars-private included, with no project added
 * at all; a symlink inside a cloned repository did the same through the
 * project that holds it (confirmed by the auditor on upstream and the fork).
 *
 * How it can fail, written before the fix (2026-09-27):
 * 1. fs:read-text-file reads the home, ~/.ssh or ~/.tars-private through a
 *    link under ~/.dorothy.
 * 2. fs:write-text-file overwrites a file there, or creates a new one, the
 *    same way.
 * 3. A link inside a project (a folder link, or a symlinked file) reads or
 *    writes outside the project.
 * 4. fs:read-project-files reads outside through a link in the relative part,
 *    or through a base that is a link.
 * 5. local-file:// serves a file outside through a link.
 * 6. A link that stays inside the project is refused, or a new file in the
 *    project can no longer be created: the Brain page breaks.
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
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const onWindows = process.platform === 'win32';
const agents = new Map<string, AgentStatus>();
const linkDir = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, onWindows ? 'junction' : 'dir'); };

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
const ssh = path.join(home, '.ssh');
const KEY = path.join(ssh, 'id_rsa');
const SECRET = path.join(PRIVATE_DIR, 'hermes-webhook-secret');
const PROFILE = path.join(home, '.bashrc');
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-real-path-project-')));
const docs = path.join(project, 'docs');

afterAll(() => { fs.rmSync(project, { recursive: true, force: true }); });

beforeEach(() => {
  handlers.clear();
  agents.clear();
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(KEY, 'the key');
  fs.writeFileSync(SECRET, 'the secret');
  fs.writeFileSync(PROFILE, 'the profile');
  fs.writeFileSync(path.join(docs, 'a.md'), 'a doc');
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([project]));
  linkDir(home, path.join(DATA_DIR, 'h'));
  linkDir(ssh, path.join(DATA_DIR, 's'));
  linkDir(PRIVATE_DIR, path.join(DATA_DIR, 'p'));
  linkDir(ssh, path.join(project, 'escape'));
  linkDir(docs, path.join(project, 'docs-link'));
  registerIpcHandlers(deps());
});

const readText = (file: string) => handlers.get('fs:read-text-file')!({}, file) as Promise<{ content: string; error?: string }>;
const writeText = (file: string, content: string) => handlers.get('fs:write-text-file')!({}, { filePath: file, content }) as Promise<{ success: boolean; error?: string }>;
const readProject = (base: string, rel: string) =>
  handlers.get('fs:read-project-files')!({}, { paths: [base], relative: [rel] }) as Promise<{ files: Record<string, string> }>;

/** Nothing outside moved. */
function untouched() {
  expect(fs.readFileSync(KEY, 'utf8')).toBe('the key');
  expect(fs.readFileSync(SECRET, 'utf8')).toBe('the secret');
  expect(fs.readFileSync(PROFILE, 'utf8')).toBe('the profile');
  expect(fs.readdirSync(ssh).sort()).toEqual(['id_rsa']);
  expect(fs.readdirSync(PRIVATE_DIR).sort()).toEqual(['hermes-webhook-secret']);
}

describe('1, 2. a link under ~/.dorothy', () => {
  const through = [
    ['the home', path.join(DATA_DIR, 'h', '.ssh', 'id_rsa'), path.join(DATA_DIR, 'h', '.bashrc'), path.join(DATA_DIR, 'h', '.new-profile')],
    ['~/.ssh', path.join(DATA_DIR, 's', 'id_rsa'), path.join(DATA_DIR, 's', 'id_rsa'), path.join(DATA_DIR, 's', 'authorized_keys')],
    ['~/.tars-private', path.join(DATA_DIR, 'p', 'hermes-webhook-secret'), path.join(DATA_DIR, 'p', 'hermes-webhook-secret'), path.join(DATA_DIR, 'p', 'new')],
  ] as const;

  for (const [name, readable, existing, fresh] of through) {
    it(`to ${name}: read refused`, async () => {
      const out = await readText(readable);
      expect(out.content).toBe('');
      expect(out.error).toBeTruthy();
    });

    it(`to ${name}: write refused, an existing file and a new one`, async () => {
      expect((await writeText(existing, 'overwritten')).success).toBe(false);
      expect((await writeText(fresh, 'planted')).success).toBe(false);
      untouched();
      expect(fs.existsSync(path.join(home, '.new-profile'))).toBe(false);
    });
  }
});

describe('3. a link inside a project', () => {
  it('a folder link out of it: read and write refused', async () => {
    expect((await readText(path.join(project, 'escape', 'id_rsa'))).content).toBe('');
    expect((await writeText(path.join(project, 'escape', 'id_rsa'), 'overwritten')).success).toBe(false);
    expect((await writeText(path.join(project, 'escape', 'authorized_keys'), 'planted')).success).toBe(false);
    untouched();
  });

  it.skipIf(cannotSymlink())('a symlinked file out of it: read and write refused', async () => {
    const file = path.join(project, 'CLAUDE.md');
    if (!fs.existsSync(file)) fs.symlinkSync(KEY, file, 'file');
    expect((await readText(file)).content).toBe('');
    expect((await writeText(file, 'overwritten')).success).toBe(false);
    untouched();
  });
});

describe('4. fs:read-project-files', () => {
  it('refuses a link in the relative part, and a base that is a link out', async () => {
    expect((await readProject(project, path.join('escape', 'id_rsa'))).files).toEqual({});
    expect((await readProject(path.join(project, 'escape'), 'id_rsa')).files).toEqual({});
  });

  it.skipIf(cannotSymlink())('refuses a symlinked file out of the project', async () => {
    const file = path.join(project, 'AGENTS.md');
    if (!fs.existsSync(file)) fs.symlinkSync(KEY, file, 'file');
    expect((await readProject(project, 'AGENTS.md')).files).toEqual({});
  });
});

describe('6. a link that stays inside the project, and a new file', () => {
  it('fs:read-text-file and fs:write-text-file still read, write and create', async () => {
    expect((await readText(path.join(project, 'docs-link', 'a.md'))).content).toBe('a doc');
    expect((await writeText(path.join(project, 'docs-link', 'a.md'), 'edited')).success).toBe(true);
    expect(fs.readFileSync(path.join(docs, 'a.md'), 'utf8')).toBe('edited');
    expect((await writeText(path.join(project, 'docs-link', 'b.md'), 'new')).success).toBe(true);
    expect(fs.readFileSync(path.join(docs, 'b.md'), 'utf8')).toBe('new');
    expect((await writeText(path.join(project, 'CLAUDE.local.md'), 'new')).success).toBe(true);
  });

  it('fs:read-project-files still reads through it', async () => {
    fs.writeFileSync(path.join(docs, 'a.md'), 'a doc');
    expect(Object.values((await readProject(project, path.join('docs-link', 'a.md'))).files)).toEqual(['a doc']);
    expect(Object.values((await readProject(path.join(project, 'docs-link'), 'a.md')).files)).toEqual(['a doc']);
  });
});

// Not on win32: there local-file:// serves no file at all (its pathname,
// `/C:/...`, resolves to `C:\C:\...`; project-roots-exclude-home.test.ts).
describe.skipIf(onWindows)('5. local-file://', () => {
  beforeEach(() => {
    protocols.clear();
    setupProtocolHandler();
  });
  const serve = async (file: string) => {
    const url = new URL('local-file://');
    url.pathname = file.replace(/\\/g, '/');
    return (await protocols.get('local-file')!({ url: url.href })).status;
  };

  it('refuses a file outside through a link, serves one inside', async () => {
    expect(await serve(path.join(DATA_DIR, 'h', '.ssh', 'id_rsa'))).toBe(403);
    expect(await serve(path.join(DATA_DIR, 'p', 'hermes-webhook-secret'))).toBe(403);
    expect(await serve(path.join(project, 'escape', 'id_rsa'))).toBe(403);
    expect(await serve(path.join(project, 'docs-link', 'a.md'))).toBe(200);
  });
});
