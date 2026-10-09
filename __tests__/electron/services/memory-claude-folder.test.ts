import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Memory and Brain find the folder Claude Code keeps a project's memory in,
 * whatever characters the project's path holds.
 *
 * Claude Code names a project's folder under ~/.claude/projects after its path
 * with every character that is not an ASCII letter or digit turned into `-`:
 * `/Users/noah/My Project` is `-Users-noah-My-Project`. memory-hub and the
 * observations file already name it that way. memory-service turned only `/`
 * and `.` into `-`:
 * - a Tars project Claude never opened got its MEMORY.md created in
 *   `-Users-noah-My Project`, a folder Claude Code never reads;
 * - the folder Claude did write decodes back as `/Users/noah/My/Project` (a
 *   space cannot be rebuilt from a `-`), so Brain listed the memory under that
 *   guess, as "Project", and the known project again beside it, empty.
 *
 * How it can fail, written before the fix:
 * 1. a project whose path holds a space, an underscore or any other character
 *    gets its memory folder under a name Claude does not give;
 * 2. the memory Claude keeps for a known project is listed under the decoder's
 *    guess instead of the project's own path;
 * 3. the known project is listed a second time, empty;
 * 4. the same for a project saved through a link, whose folder Claude names
 *    after the real path;
 * 5. a folder no known project names is no longer listed, or listed
 *    differently.
 *
 * The decoder is a stand-in that cannot rebuild a space, as the real one
 * cannot: every `-` becomes a separator. So the run is the same on any host.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mem-folder-')));
const fakeHome = path.join(tmp, 'home');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});
vi.mock('../../../electron/utils/decode-project-path', () => ({
  decodeProjectPath: (name: string) => `/${name.replace(/^-/, '').split('-').join('/')}`,
}));

const projects = path.join(fakeHome, '.claude', 'projects');
const claudeName = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

/** Claude Code's folder for `projectPath`, with a MEMORY.md in it. */
function claudeKept(projectPath: string): string {
  const folder = path.join(projects, claudeName(projectPath));
  fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'memory', 'MEMORY.md'), `# ${projectPath}\n`);
  return path.basename(folder);
}

async function list(known: string[]) {
  vi.resetModules();
  const { listProjectMemories } = await import('../../../electron/services/memory-service');
  return (await listProjectMemories(known))
    .filter(p => p.provider === 'claude' || p.id.startsWith('tars:'))
    .map(p => ({ projectPath: p.projectPath, name: p.projectName, hasMemory: p.hasMemory, folder: path.basename(path.dirname(p.memoryDir)) }));
}

beforeEach(() => { fs.rmSync(projects, { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('the folder a project\'s memory is created in', () => {
  it('1. is Claude Code\'s own name, for a space, an underscore, a dot or anything else', async () => {
    const listed = await list(['/Users/noah/My Project', '/Users/noah/my_app.v2', '/Users/noah/tars']);
    expect(listed.map(p => [p.projectPath, p.folder])).toEqual(expect.arrayContaining([
      ['/Users/noah/My Project', '-Users-noah-My-Project'],
      ['/Users/noah/my_app.v2', '-Users-noah-my-app-v2'],
      ['/Users/noah/tars', '-Users-noah-tars'],
    ]));
  });
});

describe('Brain\'s list', () => {
  it('2, 3, 5. names a known project\'s folder by the project, once, and every other folder as before', async () => {
    claudeKept('/Users/noah/My Project');
    claudeKept('/Users/noah/other');
    const listed = await list(['/Users/noah/My Project']);
    expect(listed).toEqual(expect.arrayContaining([
      { projectPath: '/Users/noah/My Project', name: 'My Project', hasMemory: true, folder: '-Users-noah-My-Project' },
      { projectPath: '/Users/noah/other', name: 'other', hasMemory: true, folder: '-Users-noah-other' },
    ]));
    expect(listed).toHaveLength(2);
  });

  it('4. a project saved through a link: the folder Claude names after the real path is that project', async () => {
    const real = path.join(tmp, 'work', 'My Project');
    const link = path.join(tmp, 'link to work');
    fs.mkdirSync(real, { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    // A junction on Windows, which any account may make; the type is ignored elsewhere.
    fs.symlinkSync(path.dirname(real), link, 'junction');
    const saved = path.join(link, 'My Project');
    claudeKept(fs.realpathSync(saved));

    const listed = await list([saved]);
    expect(listed).toEqual([{ projectPath: saved, name: 'My Project', hasMemory: true, folder: claudeName(fs.realpathSync(saved)) }]);
  });
});
