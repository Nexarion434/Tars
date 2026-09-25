import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * agents.json saved while another process reads it (ETHOS 7; the reviewer's
 * gate of win/paths-memory-security). saveAgents ends in a rename over the
 * live file, which Windows refuses while any process holds it open, and the
 * error is only logged: the change made in the app never reached the disk,
 * and nothing said so.
 *
 * How it can fail, written before the fix:
 * 1. a save made while a reader holds the file leaves the previous list on disk;
 * 2. a reader sees a partial file.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agents-read-')));
const AGENTS_FILE = path.join(tmp, 'agents.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.4.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

const READER = `
const fs = require('fs');
const [file, stop] = process.argv.slice(1);
const pause = new Int32Array(new SharedArrayBuffer(4));
let torn = 0;
process.stdout.write('ready\\n');
while (!fs.existsSync(stop)) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (!['EPERM', 'EBUSY', 'EACCES', 'ENOENT'].includes(e.code)) torn++; }
  if (text !== undefined) { try { JSON.parse(text); } catch { torn++; } }
  Atomics.wait(pause, 0, 0, 1);
}
process.stdout.write(JSON.stringify({ torn }));
`;

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('saveAgents while other programs read agents.json', () => {
  it('1, 2. every save reaches the disk, and no reader sees half a file', async () => {
    const manager = await import('../../../electron/core/agent-manager');
    manager.loadAgents();
    const stop = path.join(tmp, 'stop');
    const readers = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['-e', READER, AGENTS_FILE, stop], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      const ready = new Promise<void>(resolve => child.stdout.on('data', (d: Buffer) => { out += d; if (out.includes('ready')) resolve(); }));
      const done = new Promise<{ torn: number }>(resolve => child.on('exit', () => resolve(JSON.parse(out.slice(out.indexOf('{'))))));
      return { ready, done };
    });
    const lost: number[] = [];
    try {
      await Promise.all(readers.map(r => r.ready));
      for (let n = 0; n < 40; n++) {
        manager.agents.set('a1', {
          id: 'a1', name: `save ${n}`, status: 'idle', projectPath: tmp, output: [],
          lastActivity: new Date().toISOString(), provider: 'claude', skills: [],
        } as never);
        manager.saveAgents();
        const onDisk = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).agents[0]?.name;
        if (onDisk !== `save ${n}`) lost.push(n);
      }
    } finally {
      fs.writeFileSync(stop, '');
      manager.stopAgentAutosave();
    }
    const torn = (await Promise.all(readers.map(r => r.done))).reduce((a, r) => a + r.torn, 0);
    expect({ lost, torn }).toEqual({ lost: [], torn: 0 });
  }, 120_000);
});
