import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The busy check's PowerShell query is answered from a process table: see cli-updater-windows-fakes.ts.
vi.mock('child_process', async (importOriginal) => {
  const { childProcessForTests } = await import('./cli-updater-windows-fakes');
  return childProcessForTests(await importOriginal<typeof import('child_process')>());
});

import { npmPackage, npmPrefixWith } from './cli-updater-windows-fakes';
import { runCliUpdatePass, type CliUpdateContext } from '../../../electron/services/cli-updater';

/**
 * An Amp update that worked, and a scratch folder Windows still holds.
 *
 * The npm update runs in a scratch folder deleted in a `finally`. On Windows a
 * folder stays held for a moment after the process that used it exits: npm's
 * own child, an antivirus reading the tarball just written. Deleted in that
 * moment, rmSync throws EBUSY (EPERM under Electron), and a throw from a
 * `finally` replaces the update's result: the pass logged "failed: EBUSY ...
 * rmdir tars-cli-update-..." for an Amp that had been updated.
 *
 * How it can fail, written before the fix:
 * 1. a hold that ends inside the retry budget still turns "updated" into
 *    "failed", its detail the delete's error instead of the update's;
 * 2. the result is right but the scratch folder, and the npm cache in it, is
 *    left behind once the hold ends;
 * 3. the cleanup does not wait for the hold at all (the result comes back
 *    before the holder let go, so the test would prove nothing).
 */

vi.setConfig({ testTimeout: 60_000 });

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/**
 * npm's cli, faked: answers `view` with FAKE_LATEST, and on the global install
 * rewrites the manifest, then leaves a child behind holding the scratch folder
 * (the parent of --cache) as its working directory for FAKE_HOLD_MS. npm
 * exits only once the child says it is running: a child still starting has
 * not opened its working directory yet, and under load the delete once ran in
 * that gap, got the folder, and the child died at start. The child writes
 * when it let go to FAKE_RELEASED.
 */
const FAKE_NPM = `
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const args = process.argv.slice(2);
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); process.exit(0); }
if (args[0] === 'install' && args.includes('--global')) {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
  const scratch = path.dirname(args[args.indexOf('--cache') + 1]);
  const running = process.env.FAKE_RELEASED + '.running';
  const held = "const fs = require('fs'); fs.writeFileSync(process.env.FAKE_RELEASED + '.running', ''); setTimeout(() => { fs.writeFileSync(process.env.FAKE_RELEASED, String(Date.now())); process.exit(0); }, Number(process.env.FAKE_HOLD_MS))";
  spawn(process.execPath, ['-e', held], { cwd: scratch, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }).unref();
  for (const until = Date.now() + 20000; !fs.existsSync(running) && Date.now() < until;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
process.exit(0);
`;

let root: string;
/** Where the holder writes when it let go; waited for after each test, so a failing run leaves nothing held. */
let released: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars cli-update scratch-held ')));
  released = path.join(root, 'released');
});

afterEach(async () => {
  for (const until = Date.now() + 10_000; !fs.existsSync(released) && Date.now() < until;) await new Promise(r => setTimeout(r, 50));
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 60_000);

function ctxFor(home: string, env: Record<string, string>): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    env: {
      USERPROFILE: home,
      HOME: home,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: [path.join(home, 'AppData', 'Roaming', 'npm'), SYSTEM32].join(';'),
      ...env,
    },
  };
}

const scratchFolders = () => new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('tars-cli-update-')));

describe.skipIf(process.platform !== 'win32')('the npm scratch folder, still held when the update is done (win32)', () => {
  it('1, 2, 3. reports the update, and the folder goes once the hold ends', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefixWith(home, FAKE_NPM);
    npmPackage(prefix);
    const before = scratchFolders();

    const [result] = await runCliUpdatePass([{ cli: 'amp', command: 'amp' }], ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_HOLD_MS: '400', FAKE_RELEASED: released }));
    const returnedAt = Date.now();

    expect(result).toMatchObject({ cli: 'amp', outcome: 'updated', from: '0.0.1', to: '0.0.2' });
    expect(result.detail).not.toMatch(/EBUSY|EPERM|rmdir/);
    expect([...scratchFolders()].filter(n => !before.has(n))).toEqual([]);
    // The holder let go before the update came back: the cleanup met the hold and waited it out.
    expect(fs.existsSync(released)).toBe(true);
    expect(Number(fs.readFileSync(released, 'utf8'))).toBeLessThanOrEqual(returnedAt);
  });
});
