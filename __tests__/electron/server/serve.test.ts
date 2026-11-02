import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A Tars server boots: plain Node, no window, no display, the whole of main.ts
 * under the headless electron (docs/superpowers/plans/2026-11-02-tars-cloud.md,
 * Task 4). The entry is compiled first, as the server runs it, and started as
 * a child under the no-electron guard, so a package that requires `electron`
 * through Node itself (not through vitest's mocks) is proven too.
 *
 * How it fails:
 * - Electron's own package loaded (the guard ends the process)
 * - the boot stopping before `App initialization complete`, or throwing on a
 *   member the headless electron lacks, or on a window step not skipped
 * - the local API not answering /api/health on its port
 * - SIGTERM leaving the process running past 20 s (POSIX: on Windows a signal
 *   is a hard kill, and a server runs on Linux)
 */

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'electron', 'dist', 'server', 'main.js');
const GUARD = path.join(ROOT, '__tests__', 'fixtures', 'no-electron.cjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | null = null;
afterEach(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
});

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'electron', 'tsconfig.json')], { stdio: 'pipe' });
}, 300_000);

async function boot(): Promise<{ port: number; output: () => string; exited: Promise<number | null> }> {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-server-state-'));
  let output = '';
  child = spawn(process.execPath, ['-r', GUARD, ENTRY], {
    cwd: os.tmpdir(),
    env: { ...process.env, DOROTHY_API_PORT: String(port), XDG_STATE_HOME: state, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', chunk => { output += String(chunk); });
  child.stderr!.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<number | null>(resolve => child!.once('exit', code => resolve(code)));
  const deadline = Date.now() + 120_000;
  while (!output.includes('App initialization complete')) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`the server did not finish booting (exit ${child.exitCode}):\n${output.slice(-4000)}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { port, output: () => output, exited };
}

describe('tars-server', () => {
  it('boots main.ts headless and answers on its local API', async () => {
    const { port, output } = await boot();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(output()).not.toMatch(/no-electron guard|Electron failed to install|Downloading Electron/);
  }, 180_000);

  it.skipIf(process.platform === 'win32')('ends on SIGTERM through the quit steps', async () => {
    const { exited } = await boot();
    child!.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<string>(r => setTimeout(() => r('still running'), 20_000))]);
    expect(code).toBe(0);
  }, 180_000);
});
