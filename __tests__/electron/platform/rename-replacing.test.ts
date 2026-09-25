import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameReplacingSync, RENAME_RETRY_BUDGET_MS } from '../../../electron/platform';
import { writeAtomicSync } from '../../../electron/utils/secret-file';
import { updateSharedJsonSync } from '../../../electron/utils/shared-file';

/**
 * Replacing a file another program is reading (audit B S-02). Every atomic
 * write in Tars ends in a rename over the live file: app-settings.json,
 * agents.json, ~/.claude.json, mcp.json. On Windows that rename fails with
 * EPERM while any process holds the file open, even for reading; measured on
 * this machine, 198 of 200 renames failed under 20 Node readers. Claude Code
 * reads ~/.claude.json at every start and the MCP servers read
 * app-settings.json at every call, so a Settings save could fail at random.
 *
 * How it can fail, written before the code:
 * 1. darwin/linux change: anything but one plain rename, its error untouched;
 * 2. win32 gives up at the first EPERM, EBUSY or EACCES a reader causes;
 * 3. win32 retries forever, or longer than about a second, blocking the main
 *    process;
 * 4. win32 retries an error no reader causes (ENOENT, EXDEV), hiding it;
 * 5. the error at the end does not say which file, how long, or keeps no code;
 * 6. under 20 readers and 200 writes, a write fails or a reader sees a
 *    truncated or half-written file (the stress test below, on the real disk).
 */

const err = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

function fakes(outcomes: Array<string | null>) {
  const calls: Array<[string, string]> = [];
  const slept: number[] = [];
  let now = 0;
  return {
    calls, slept,
    deps: {
      rename: (from: string, to: string) => {
        calls.push([from, to]);
        const next = outcomes.length ? outcomes.shift()! : null;
        if (next) throw err(next);
      },
      sleep: (ms: number) => { slept.push(ms); now += ms; },
      now: () => now,
    },
  };
}

describe('renameReplacingSync', () => {
  it('1. darwin and linux: one rename, and its own error', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const f = fakes(['EPERM']);
      let thrown: unknown;
      try { renameReplacingSync('a.tmp', 'a', { ...f.deps, platform }); } catch (e) { thrown = e; }
      expect(f.calls).toEqual([['a.tmp', 'a']]);
      expect((thrown as Error).message).toBe('EPERM: operation not permitted, rename');
      expect(f.slept).toEqual([]);
    }
  });

  it('2. win32: waits out a reader, whatever it answers', () => {
    const f = fakes(['EPERM', 'EBUSY', 'EACCES', 'EPERM', null]);
    renameReplacingSync('a.tmp', 'a', { ...f.deps, platform: 'win32' });
    expect(f.calls).toHaveLength(5);
    expect(f.slept.length).toBe(4);
    expect(f.slept.every((ms, i) => i === 0 || ms >= f.slept[i - 1])).toBe(true);
  });

  it('3, 5. win32: stops after about a second, and says what, how long and why', () => {
    const f = fakes(Array(10_000).fill('EBUSY'));
    let thrown: NodeJS.ErrnoException | undefined;
    try { renameReplacingSync('C:\\d\\a.tmp', 'C:\\d\\a', { ...f.deps, platform: 'win32' }); } catch (e) { thrown = e as NodeJS.ErrnoException; }
    const total = f.slept.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(RENAME_RETRY_BUDGET_MS * 0.9);
    expect(total).toBeLessThanOrEqual(RENAME_RETRY_BUDGET_MS * 1.1);
    expect(thrown?.code).toBe('EBUSY');
    expect(thrown?.message).toContain('C:\\d\\a');
    expect(thrown?.message).toMatch(/open by another program/);
    expect(thrown?.message).toMatch(/\d+ ms/);
    expect(thrown?.message).toContain('EBUSY');
  });

  it('4. win32: an error no reader causes is thrown at once', () => {
    for (const code of ['ENOENT', 'EXDEV', 'ENOSPC']) {
      const f = fakes([code]);
      expect(() => renameReplacingSync('a.tmp', 'a', { ...f.deps, platform: 'win32' })).toThrow(code);
      expect(f.calls).toHaveLength(1);
    }
  });
});

// ── 6. The real disk: 20 reader processes, 200 writes through each writer ─────

const READER = `
const fs = require('fs');
const [file, stop] = process.argv.slice(1);
const pause = new Int32Array(new SharedArrayBuffer(4));
let reads = 0, torn = 0, refused = 0;
process.stdout.write('ready\\n');
while (!fs.existsSync(stop)) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // The instant the rename swaps the file, Windows may refuse the open: a
    // read that did not happen, not a partial one.
    if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) refused++; else torn++;
  }
  if (text !== undefined) {
    try {
      const doc = JSON.parse(text);
      if (typeof doc.n !== 'number' || doc.pad.length !== 20000) torn++;
      reads++;
    } catch {
      torn++;
    }
  }
  Atomics.wait(pause, 0, 0, 1 + Math.floor(Math.random() * 3));
}
process.stdout.write(JSON.stringify({ reads, torn, refused }));
`;

describe('6. twenty readers, two hundred writes', () => {
  it('every write lands and no reader ever sees a partial file', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-rename-stress-')));
    const file = path.join(dir, 'app-settings.json');
    const stop = path.join(dir, 'stop');
    const pad = 'x'.repeat(20000);
    fs.writeFileSync(file, JSON.stringify({ n: -1, pad }));
    const readers = Array.from({ length: 20 }, () => {
      const child = spawn(process.execPath, ['-e', READER, file, stop], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      const ready = new Promise<void>(resolve => child.stdout.on('data', (d: Buffer) => { out += d; if (out.includes('ready')) resolve(); }));
      const done = new Promise<{ reads: number; torn: number }>(resolve => child.on('exit', () => resolve(JSON.parse(out.slice(out.indexOf('{'))))));
      return { ready, done };
    });
    const failures: string[] = [];
    try {
      await Promise.all(readers.map(r => r.ready));
      for (let n = 0; n < 200; n++) {
        try { writeAtomicSync(file, JSON.stringify({ n, pad })); } catch (e) { failures.push(`writeAtomicSync ${n}: ${(e as Error).message}`); }
      }
      for (let n = 200; n < 400; n++) {
        try {
          const r = updateSharedJsonSync<{ n: number; pad: string }>(file, () => ({ n, pad }));
          if (r !== 'written') failures.push(`updateSharedJsonSync ${n}: ${r}`);
        } catch (e) { failures.push(`updateSharedJsonSync ${n}: ${(e as Error).message}`); }
      }
    } finally {
      fs.writeFileSync(stop, '');
    }
    const seen = await Promise.all(readers.map(r => r.done));
    const torn = seen.reduce((a, s) => a + s.torn, 0);
    const reads = seen.reduce((a, s) => a + s.reads, 0);
    const last = JSON.parse(fs.readFileSync(file, 'utf8')).n;
    fs.rmSync(dir, { recursive: true, force: true });

    expect({ failures: failures.length, first: failures.slice(0, 3), torn, last }).toEqual({ failures: 0, first: [], torn: 0, last: 399 });
    expect(reads).toBeGreaterThan(400);
  }, 120_000);
});
