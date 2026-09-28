import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app/path' },
  Notification: vi.fn(),
  BrowserWindow: vi.fn(),
}));

/**
 * A kanban task finds the idle agent of its project whatever spelling of the
 * project path each side holds (audit B U-08). kanban-automation stripped a
 * trailing `/` and compared with `===`, so on Windows `C:\x`, `c:\x\` and
 * `C:/x` were three projects and a task never found its agent.
 * services.test.ts holds the case and the separators; this file holds the
 * other spellings Windows gives one folder.
 *
 * How it can fail, written before the code:
 *  1. The long form `\\?\C:\x` (what a realpath or a native tool can hand
 *     back) is a different project from `C:\x`.
 *  2. `~\x`, the Windows spelling of `~/x`, is not the home's `x`.
 *  3. A trailing dot or space, which Win32 drops, makes another project.
 *  4. Over-reach: a sibling that shares the prefix (`C:\x2`), or the parent,
 *     is taken for the project.
 *  5. darwin/linux: the comparison changes (case must still count there).
 *
 * The platform is set per case, so every case runs on any host.
 */

const HOST = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
afterEach(() => setPlatform(HOST));

type Agent = { id: string; status: string; projectPath: string; skills: string[] };
const agents = new Map<string, Agent>();
let kanban: typeof import('../../../electron/services/kanban-automation');

beforeEach(async () => {
  agents.clear();
  kanban = await import('../../../electron/services/kanban-automation');
  kanban.initKanbanAutomation({ agents: agents as never, createAgent: (async () => ({})) as never, saveAgents: () => {} });
});

const idle = (projectPath: string) => agents.set('1', { id: '1', status: 'idle', projectPath, skills: [] });

describe('findMatchingAgent on win32', () => {
  beforeEach(() => setPlatform('win32'));

  it('1: the long form names the same project', async () => {
    idle('C:\\Work\\Project');
    expect(await kanban.findMatchingAgent('\\\\?\\c:\\work\\project\\', [])).toBe('1');
  });

  it('2: ~\\ is the home directory', async () => {
    idle(path.win32.join(os.homedir(), 'Work', 'Project'));
    expect(await kanban.findMatchingAgent('~\\Work\\Project', [])).toBe('1');
  });

  it('3: a trailing dot or space is dropped, as Win32 drops it', async () => {
    idle('C:\\Work\\Project');
    expect(await kanban.findMatchingAgent('C:\\Work\\Project. ', [])).toBe('1');
  });

  it('4: a sibling sharing the prefix, or the parent, is another project', async () => {
    idle('C:\\Work\\Project');
    expect(await kanban.findMatchingAgent('C:\\Work\\Project2', [])).toBeNull();
    expect(await kanban.findMatchingAgent('C:\\Work', [])).toBeNull();
  });
});

describe('findMatchingAgent on darwin and linux (case 5)', () => {
  it.each(['darwin', 'linux'] as const)('%s: case still counts, a trailing / still does not', async (platform) => {
    setPlatform(platform);
    idle('/work/project/');
    expect(await kanban.findMatchingAgent('/work/project', [])).toBe('1');
    expect(await kanban.findMatchingAgent('/Work/Project', [])).toBeNull();
  });
});
