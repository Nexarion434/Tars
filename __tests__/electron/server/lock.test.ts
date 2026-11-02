import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { answersHealth, claimDataFolder, readServerRecord, serverStatus } from '../../../electron/server/lock';
import { detachedEnv, startServer } from '../../../electron/server/start';

/**
 * One Tars server per data folder, and never a server on the folder a Tars
 * already runs on (plan Task 4, Review Focus 3): two processes writing the same
 * agents.json lose agents. The record (PRIVATE_DIR/server.json) is what
 * `status` reads and what the desktop's link reads over SSH in M2.
 *
 * How it fails:
 * - a second server started while the first one's pid lives
 * - a server started while a Tars answers /api/health on the folder's port
 *   (the desktop, or a server that lost its record), or a record written then
 * - a record left by a server that died blocking every later start
 * - the record readable by other accounts (POSIX), or missing its pid, port
 *   or version
 * - release() removing a record another process wrote since
 * - the health probe hanging on a port that accepts and never answers
 * - status() saying running for a record whose pid is gone
 * - start launching a second server when one runs; going around the systemd
 *   unit when it is installed; reporting started when nothing came up
 */

const servers: Array<http.Server | net.Server> = [];
const children: number[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise(r => s.close(() => r(null)));
  for (const pid of children.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-lock-')), 'server.json');
}

function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  const port = await new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
  await new Promise(r => s.close(() => r(null)));
  return port;
}

/** A live process; one that looks like a Tars server in /proc unless asServer is false. */
function sleeper(asServer = true): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ...(asServer ? ['electron/dist/server/main.js'] : [])], { stdio: 'ignore' });
  children.push(child.pid!);
  return Promise.resolve(child.pid!);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => child.once('exit', r));
  return child.pid!;
}

const record = { version: '9.9.9', startedAt: '2026-11-02T00:00:00.000Z', startedBy: 'shell' as const };

describe('claimDataFolder', () => {
  it('refuses while a live server holds the folder, and leaves its record', async () => {
    const file = tmpFile();
    const pid = await sleeper();
    fs.writeFileSync(file, JSON.stringify({ ...record, pid, apiPort: 31415 }));
    const claim = await claimDataFolder({ file, apiPort: await freePort(), record });
    expect(claim).toEqual({ ok: false, heldBy: 'server', pid, apiPort: 31415 });
    expect(readServerRecord(file)?.pid).toBe(pid);
  });

  it.skipIf(!fs.existsSync('/proc/self/cmdline'))('takes over a record whose pid now runs something else', async () => {
    const file = tmpFile();
    const pid = await sleeper(false);
    fs.writeFileSync(file, JSON.stringify({ ...record, pid, apiPort: 31415 }));
    const claim = await claimDataFolder({ file, apiPort: await freePort(), record });
    expect(claim.ok).toBe(true);
    expect(readServerRecord(file)?.pid).toBe(process.pid);
  });

  it('takes over the record of a server that died', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ ...record, pid: await deadPid(), apiPort: 31415 }));
    const apiPort = await freePort();
    const claim = await claimDataFolder({ file, apiPort, record });
    expect(claim.ok).toBe(true);
    expect(readServerRecord(file)).toMatchObject({ pid: process.pid, apiPort, version: '9.9.9' });
  });

  it('refuses a folder whose port a Tars answers, and writes nothing', async () => {
    const file = tmpFile();
    const apiPort = await listen(http.createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end('{}'); }));
    const claim = await claimDataFolder({ file, apiPort, record });
    expect(claim).toEqual({ ok: false, heldBy: 'tars', apiPort });
    expect(fs.existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes its record for its owner alone', async () => {
    const file = tmpFile();
    const claim = await claimDataFolder({ file, apiPort: await freePort(), record });
    expect(claim.ok).toBe(true);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('releases its own record, never another process\'s', async () => {
    const file = tmpFile();
    const claim = await claimDataFolder({ file, apiPort: await freePort(), record });
    if (!claim.ok) throw new Error('claim refused');
    claim.release();
    expect(fs.existsSync(file)).toBe(false);

    const again = await claimDataFolder({ file, apiPort: await freePort(), record });
    if (!again.ok) throw new Error('claim refused');
    const other = await sleeper();
    fs.writeFileSync(file, JSON.stringify({ ...record, pid: other, apiPort: 1 }));
    again.release();
    expect(readServerRecord(file)?.pid).toBe(other);
  });
});

describe('answersHealth', () => {
  it('gives up on a port that accepts and never answers', async () => {
    const held: net.Socket[] = [];
    const port = await listen(net.createServer(socket => { held.push(socket); }));
    const started = Date.now();
    expect(await answersHealth(port, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    for (const socket of held) socket.destroy();
  });
});

describe('serverStatus', () => {
  it('is running only while the recorded pid lives', async () => {
    const file = tmpFile();
    expect(serverStatus(file)).toEqual({ running: false });
    fs.writeFileSync(file, JSON.stringify({ ...record, pid: await deadPid(), apiPort: 31415 }));
    expect(serverStatus(file)).toEqual({ running: false });
    const pid = await sleeper();
    fs.writeFileSync(file, JSON.stringify({ ...record, pid, apiPort: 31415 }));
    expect(serverStatus(file)).toEqual({ running: true, ...record, pid, apiPort: 31415 });
  });
});

describe('detachedEnv', () => {
  it('keeps no SSH session in what a detached server and its agents inherit', () => {
    const env = detachedEnv({ PATH: '/usr/bin', HOME: '/home/tars', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', SSH_CONNECTION: '1 2 3 4', SSH_CLIENT: '1 2 3', SSH_TTY: '/dev/pts/1' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/tars', TARS_SERVER_STARTED_BY: 'cli' });
  });
});

describe('startServer', () => {
  const running = { running: true as const, ...record, pid: 42, apiPort: 31415 };

  function deps(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
    const calls: string[] = [];
    let state: ReturnType<typeof serverStatus> = { running: false };
    return {
      calls,
      deps: {
        status: () => state,
        hasUnit: () => false,
        startUnit: () => { calls.push('unit'); state = running; },
        spawnDetached: () => { calls.push('spawn'); state = running; },
        sleep: async () => {},
        timeoutMs: 1000,
        ...overrides,
      },
    };
  }

  it('starts nothing when a server runs', async () => {
    const { calls, deps: d } = deps({ status: () => running });
    expect(await startServer(d)).toEqual(running);
    expect(calls).toEqual([]);
  });

  it('goes through the systemd unit when it is installed', async () => {
    const { calls, deps: d } = deps({ hasUnit: () => true });
    expect(await startServer(d)).toEqual(running);
    expect(calls).toEqual(['unit']);
  });

  it('starts a detached server otherwise', async () => {
    const { calls, deps: d } = deps();
    expect(await startServer(d)).toEqual(running);
    expect(calls).toEqual(['spawn']);
  });

  it('says so when nothing came up in time', async () => {
    let now = 0;
    const { deps: d } = deps({ spawnDetached: () => {}, sleep: async () => { now += 250; }, now: () => now });
    await expect(startServer(d)).rejects.toThrow(/did not start/);
  });
});
