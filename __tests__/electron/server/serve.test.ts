import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
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
 * - a server booting on a data folder another Tars answers for (Review Focus 3)
 * - `status --json` printing more than one line, or not the running server
 */

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'electron', 'dist', 'server', 'main.js');
const GUARD = path.join(ROOT, '__tests__', 'fixtures', 'no-electron.cjs');
const CLI = path.join(ROOT, 'electron', 'dist', 'server', 'cli.js');

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

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

let child: ChildProcess | null = null;
// Waits for the exit too: on Windows a killed server holds its HOME's files
// until it is gone, and the suite's folder must be removable when the file ends.
afterEach(async () => {
  const running = child;
  child = null;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const gone = new Promise(resolve => running.once('exit', resolve));
  running.kill('SIGKILL');
  await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 10_000))]);
  await new Promise(resolve => setTimeout(resolve, 500));
});

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'electron', 'tsconfig.json')], { stdio: 'pipe' });
}, 300_000);

/**
 * Booted means every marker is in the output: the end of main.ts's boot, the
 * local API's own `listening` line (its listen is asynchronous and retries, so
 * the boot's last line can come first: a measured ECONNREFUSED), and whatever
 * else a case needs (the door's line).
 */
const BOOTED = ['App initialization complete', 'Agent API server running on'];

async function boot(markers: string[] = BOOTED): Promise<{ port: number; output: () => string; exited: Promise<number | null> }> {
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
  while (!markers.every(marker => output.includes(marker))) {
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

  it('refuses a data folder another Tars answers for', async () => {
    const fake = http.createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end('{}'); });
    const port = await new Promise<number>(r => fake.listen(0, '127.0.0.1', () => r((fake.address() as net.AddressInfo).port)));
    try {
      let output = '';
      child = spawn(process.execPath, ['-r', GUARD, ENTRY], { cwd: os.tmpdir(), env: { ...process.env, DOROTHY_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', chunk => { output += String(chunk); });
      child.stderr!.on('data', chunk => { output += String(chunk); });
      const code = await Promise.race([new Promise<number | null>(r => child!.once('exit', c => r(c))), new Promise<string>(r => setTimeout(() => r('still running'), 60_000))]);
      expect(code).toBe(1);
      expect(output).toMatch(/never shares a data folder/);
      expect(output).not.toMatch(/App initialization complete/);
    } finally {
      fake.close();
    }
  }, 120_000);

  it('clients add takes its input on stdin and prints one line, with the id status gives', () => {
    const out = execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], { input: JSON.stringify({ name: 'PC', kind: 'desktop', scopes: ['see'] }) }).toString();
    const lines = out.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0]);
    expect(Object.keys(printed).sort()).toEqual(['credential', 'id', 'serverId']);
    const status = JSON.parse(execFileSync(process.execPath, [CLI, 'status', '--json']).toString());
    expect(status.serverId).toBe(printed.serverId);
  }, 60_000);

  it('opens its door on API_PORT + 2: hello, the fleet for a client, and never the master token', async () => {
    const { port } = await boot([...BOOTED, '[cloud] door on 127.0.0.1:']);
    const env = { ...process.env, DOROTHY_API_PORT: String(port) };
    const minted = JSON.parse(execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], { input: JSON.stringify({ name: 'Mac', kind: 'desktop', scopes: ['see'] }), env }).toString());
    const door = port + 2;
    const hello = await get(door, '/cloud/v1/hello');
    expect(hello.status).toBe(200);
    expect(JSON.parse(hello.body).serverId).toBe(minted.serverId);
    const fleet = await get(door, '/cloud/v1/fleet', { Authorization: `Bearer ${minted.credential}` });
    expect(fleet.status).toBe(200);
    expect(JSON.parse(fleet.body)).toMatchObject({ v: 1, youMay: ['see'], agents: [] });
    const master = fs.readFileSync(path.join(os.homedir(), '.tars-private', 'api-token'), 'utf-8').trim();
    expect(master.length).toBeGreaterThan(16);
    expect((await get(door, '/cloud/v1/fleet', { Authorization: `Bearer ${master}` })).status).toBe(401);
    for (const answer of [hello, fleet]) expect(answer.body).not.toContain(master);
  }, 180_000);

  it('status --json reads the running server, in one line', async () => {
    // Inherited by whatever a systemd unit starts, GitHub's runner included: it says nothing of who started this server.
    process.env.INVOCATION_ID = 'inherited-from-a-unit';
    const { port } = await boot();
    delete process.env.INVOCATION_ID;
    const out = execFileSync(process.execPath, [CLI, 'status', '--json'], { env: { ...process.env, DOROTHY_API_PORT: String(port) } }).toString();
    expect(out.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(out)).toMatchObject({ running: true, pid: child!.pid, apiPort: port, startedBy: 'shell' });
  }, 180_000);
});
