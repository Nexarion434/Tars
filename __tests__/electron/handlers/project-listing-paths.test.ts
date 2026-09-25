import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The project listing and the project file reader judge a path the way the
 * platform spells it (audit B W-02).
 *
 * fs:list-projects dropped a worktree with `/\/\.?worktrees\//` and the
 * file system root with `p === '/'`: on Windows neither ever matched, so a
 * worktree under `C:\repo\.worktrees\x` and the drive root `C:\` were offered
 * as projects. fs:read-project-files refused the home folder as a root with
 * `r !== os.homedir()`: on Windows the home spelled in another case passed,
 * and with it every file under the home.
 *
 * How it can fail, written before the fix:
 * 1. win32: a project inside `.worktrees` or `worktrees`, spelled with `\`
 *    or in another case, is listed.
 * 2. win32: a drive root (`C:\`, `C:/`) is listed.
 * 3. darwin/linux: the listing no longer drops `/…/.worktrees/…` and `/` as
 *    it did, or drops something it listed.
 * 4. An ordinary project beside them is dropped (the checks prove nothing).
 * 5. win32: the home, spelled in another case in the custom projects, becomes
 *    a root the project file reader reads from.
 * 6. A project folder under the home is still read (the guard does not
 *    refuse everything).
 *
 * Added at win-reviewer's gate (2026-09-25), written before the fix:
 * 7. The home is listed as a project when it is spelled otherwise than
 *    os.homedir(): a lowercase drive (Claude's folder `c--Users-x`, from a cwd
 *    typed `c:\...`), another case, `/`, a trailing separator.
 * 8. win32: one project spelled twice (`C:epo`, `c:epo`) is listed twice.
 * 9. The dedupe merges two different folders.
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
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { DATA_DIR } from '../../../electron/constants';
import { encodeClaudeProjectDir } from '../../../electron/platform';
import { resetProjectIndex } from '../../../electron/services/project-index';

const onWindows = process.platform === 'win32';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents: new Map(), getClaudeSkills: async () => [] };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts): DATA_DIR is in it.
const work = fs.mkdtempSync(path.join(os.homedir(), 'listing-'));
const repo = path.join(work, 'repo');
const dotWorktree = path.join(repo, '.worktrees', 'feat-a');
const worktree = path.join(repo, 'Worktrees', 'feat-b');
for (const dir of [repo, dotWorktree, worktree]) fs.mkdirSync(dir, { recursive: true });
const driveRoot = path.parse(work).root;

function customProjects(list: string[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(list));
}

async function listed(): Promise<string[]> {
  const projects = await handlers.get('fs:list-projects')!({}) as Array<{ path: string }>;
  return projects.map(p => p.path);
}

beforeEach(() => {
  handlers.clear();
  registerIpcHandlers(deps());
});

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('fs:list-projects', () => {
  it.runIf(onWindows)('1, 2, 4. win32: drops worktrees and drive roots in any spelling, keeps the project', async () => {
    const spellings = [
      dotWorktree,
      worktree,
      dotWorktree.replace(/\\/g, '/'),
      dotWorktree.toUpperCase(),
      driveRoot,
      driveRoot.replace(/\\/g, '/'),
    ];
    customProjects([repo, ...spellings]);

    const paths = await listed();

    expect(paths).toContain(repo);
    for (const p of spellings) expect(paths, p).not.toContain(p);
  });

  it.runIf(!onWindows)('3, 4. darwin/linux: drops `/.../.worktrees/...`, `/.../worktrees/...` and `/` as before, keeps the project', async () => {
    customProjects([repo, dotWorktree, path.join(repo, 'worktrees', 'x'), '/']);
    fs.mkdirSync(path.join(repo, 'worktrees', 'x'), { recursive: true });

    const paths = await listed();

    expect(paths).toContain(repo);
    expect(paths).not.toContain(dotWorktree);
    expect(paths).not.toContain(path.join(repo, 'worktrees', 'x'));
    expect(paths).not.toContain('/');
    // The darwin/linux check is case-sensitive: `Worktrees` was listed, and is.
    customProjects([worktree]);
    expect(await listed()).toContain(worktree);
  });
});

describe('fs:list-projects and the home', () => {
  const home = os.homedir();
  const lowerDrive = (p: string) => p.replace(/^[A-Z]:/, d => d.toLowerCase());
  const claudeDir = path.join(home, '.claude', 'projects');
  afterAll(() => fs.rmSync(claudeDir, { recursive: true, force: true }));

  it('7. never lists the home, however the added projects spell it', async () => {
    const spellings = onWindows
      ? [lowerDrive(home), home.toLowerCase(), home.toUpperCase(), home.replace(/\\/g, '/'), `${home}\\`]
      : [`${home}/`];
    customProjects([repo, ...spellings]);

    const paths = await listed();

    expect(paths).toContain(repo);
    for (const p of spellings) expect(paths, p).not.toContain(p);
  });

  it.runIf(onWindows)('7. never lists the home from the Claude folder for a lowercase drive (c--Users-x)', async () => {
    customProjects([repo]);
    const folder = path.join(claudeDir, encodeClaudeProjectDir(lowerDrive(home)));
    expect(path.basename(folder)).toMatch(/^[a-z]--/);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '11111111-2222-4333-8444-555555555555.jsonl'), '{}\n');
    resetProjectIndex();

    const paths = await listed();

    expect(paths.filter(p => p.toLowerCase() === home.toLowerCase())).toEqual([]);
    expect(paths).toContain(repo);
  });

  it.runIf(onWindows)('8, 9. lists a project once whatever its spellings, and two projects twice', async () => {
    const other = path.join(work, 'repo2');
    fs.mkdirSync(other, { recursive: true });
    customProjects([repo, lowerDrive(repo), repo.toUpperCase(), `${repo}\\`, other]);

    const paths = await listed();

    expect(paths.filter(p => p.toLowerCase().replace(/\\+$/, '') === repo.toLowerCase())).toEqual([repo]);
    expect(paths).toContain(other);
  });
});

describe('fs:read-project-files', () => {
  it('5, 6. never takes the home as a root, in any spelling, and still reads a project under it', async () => {
    const home = os.homedir();
    fs.writeFileSync(path.join(home, 'secret.txt'), 'the home is not a project');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'a project file');
    const homeSpellings = onWindows ? [home, home.toUpperCase(), home.toLowerCase()] : [home];
    customProjects([repo, ...homeSpellings]);

    for (const spelling of homeSpellings) {
      const read = await handlers.get('fs:read-project-files')!({}, { paths: [spelling], relative: ['secret.txt'] }) as { files: Record<string, string> };
      expect(read.files, spelling).toEqual({});
    }
    const project = await handlers.get('fs:read-project-files')!({}, { paths: [repo], relative: ['CLAUDE.md'] }) as { files: Record<string, string> };
    expect(Object.values(project.files)).toEqual(['a project file']);
  });
});
