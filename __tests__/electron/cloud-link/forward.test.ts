import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { localForwardEnd } from '../../../electron/platform/local-forward';
import { openForward, ForwardError } from '../../../electron/services/cloud-link/forward';
import { createDoorClient } from '../../../electron/services/cloud-link/client';
import { createCloudLink } from '../../../electron/services/cloud-link/link';
import { saveProfile, type ServerProfile } from '../../../electron/services/cloud-link/store';
import type { RunResult } from '../../../electron/services/cloud-link/remote-run';
import type { ServerCommand } from '../../../electron/services/cloud-link/ssh';

/**
 * The forward to the server's door, and hello through it (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 5).
 * The fake `ssh` listens on the forward's local end as `ssh -L` would and
 * pipes each connection to a door the test runs.
 *
 * How it fails:
 * - `ssh` ends before the forward is ready (ExitOnForwardFailure: the port or
 *   the socket taken): ready rejects, the connect fails, nothing is left running
 * - ready never comes (a hung connection): killed at the timeout
 * - ready taken from another forward's line (a LocalForward of the user's
 *   ssh config, bound while ours failed): hello and the credential would go
 *   to a port ssh does not hold (security review 1, nit 1)
 * - a stale socket in our own folder left in the way; anything else at that
 *   path removed (it is not ours)
 * - the door missing behind the forward (a wrong door socket path): read as
 *   "the server's door is not there", not as connected
 * - hello answering another server id, and the credential sent to it anyway;
 *   the credential sent with hello, or before it
 * - Disconnect leaving the local `ssh` running, or sending the server anything
 */

const posix = process.platform !== 'win32';
const FAKE_SSH = { file: process.execPath, args: [path.join(__dirname, '..', '..', 'fixtures', 'fake-ssh.cjs')] };
const SERVER_ID = 'd795d0ff4d5d8e50';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';
const REMOTE = '/home/ubuntu/tars-cloud/home/.tars-private/door.sock';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-fwd-'));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startDoor(serverId: string) {
  const seen: Array<{ url: string; authorization?: string; host?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization, host: req.headers.host });
    if (req.url === '/cloud/v1/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: 1, serverId, name: 'srv1539916', version: '2.0.4' }));
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, seen };
}

describe('localForwardEnd', () => {
  it('win32: a free port on 127.0.0.1', async () => {
    const end = await localForwardEnd('s_1a2b3c4d', { dir: tmp(), platform: 'win32' });
    expect(end.kind).toBe('tcp');
    if (end.kind !== 'tcp') return;
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => { probe.on('error', reject); probe.listen(end.port, '127.0.0.1', resolve); });
    probe.close();
  });

  it.runIf(posix)('darwin/linux: a socket in a 0700 folder of our own', async () => {
    const dir = path.join(tmp(), 'cloud');
    const end = await localForwardEnd('s_1a2b3c4d', { dir });
    expect(end).toEqual({ kind: 'unix', path: path.join(dir, 's_1a2b3c4d.sock') });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('removes a stale socket of ours, leaves anything else and refuses', async () => {
    const dir = path.join(tmp(), 'cloud');
    const stale = path.join(dir, 's_1a2b3c4d.sock');
    fs.mkdirSync(dir, { recursive: true });
    // An ssh killed outright leaves its listening socket behind.
    const child = spawn(FAKE_SSH.file, [...FAKE_SSH.args, '-N', '-L', `${stale}:${REMOTE}`, '--', 'h'], { env: { ...process.env, FAKE_SSH_FORWARD_TO: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>(resolve => child.stderr!.on('data', (d: Buffer) => { if (/listening/.test(String(d))) resolve(); }));
    child.kill('SIGKILL');
    await new Promise(resolve => child.on('exit', resolve));
    expect(fs.lstatSync(stale).isSocket()).toBe(true);
    await localForwardEnd('s_1a2b3c4d', { dir });
    expect(fs.existsSync(stale)).toBe(false);
    fs.writeFileSync(stale, 'not ours');
    await expect(localForwardEnd('s_1a2b3c4d', { dir })).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(stale, 'utf8')).toBe('not ours');
  });

  it('refuses a key that is not a plain name', async () => {
    for (const key of ['', '../x', 'a/b', 'a b', 'x'.repeat(33)]) {
      await expect(localForwardEnd(key, { dir: tmp(), platform: 'win32' }), key).rejects.toThrow();
    }
  });
});

describe('openForward', () => {
  it('is ready once ssh listens, and hello goes through it without the credential', async () => {
    const door = await startDoor(SERVER_ID);
    const end = await localForwardEnd('s_1a2b3c4d', { dir: path.join(tmp(), 'cloud') });
    const forward = openForward('tars-vps', end, REMOTE, { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FORWARD_TO: String(door.port) } });
    cleanup.push(() => forward.close());
    await forward.ready;
    expect(await createDoorClient(end).hello()).toEqual({ ok: true, serverId: SERVER_ID });
    expect(door.seen).toEqual([{ url: '/cloud/v1/hello', authorization: undefined, host: 'localhost' }]);
  });

  it('a forward that cannot bind rejects ready and ends', async () => {
    const taken = net.createServer();
    await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => taken.close());
    const port = (taken.address() as net.AddressInfo).port;
    const forward = openForward('tars-vps', { kind: 'tcp', port }, REMOTE, { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FORWARD_TO: '1' } });
    const error = await forward.ready.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(ForwardError);
    expect((error as Error).message).toMatch(/taken|forward/i);
    expect((await forward.ended).code).toBe(255);
  });

  it("another forward's listening line is not ours: ready waits for our end, and ours failing ends it", async () => {
    const taken = net.createServer();
    await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => taken.close());
    const port = (taken.address() as net.AddressInfo).port;
    const forward = openForward('tars-vps', { kind: 'tcp', port }, REMOTE, { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FORWARD_TO: '1', FAKE_SSH_FOREIGN_FORWARD: '1' } });
    const error = await forward.ready.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(ForwardError);
    expect((await forward.ended).stderr).toContain('listening on 127.0.0.1 port 1.');
  });

  it('a forward never ready is killed at its timeout', async () => {
    const pidFile = path.join(tmp(), 'pid');
    const forward = openForward('tars-vps', { kind: 'tcp', port: 47117 }, REMOTE, { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_HANG: '1', FAKE_SSH_PID_FILE: pidFile }, readyTimeoutMs: 400 });
    const error = await forward.ready.then(() => null, (err: unknown) => err);
    expect(error).toMatchObject({ problem: 'timeout' });
    await forward.ended;
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  });

  it('a profile that fails the checks never starts ssh', async () => {
    const pidFile = path.join(tmp(), 'pid');
    const forward = openForward('-oProxyCommand=calc', { kind: 'tcp', port: 47117 }, REMOTE, { ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_PID_FILE: pidFile } });
    await expect(forward.ready).rejects.toMatchObject({ problem: 'refused' });
    await forward.ended;
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe('the link through a real forward', () => {
  function linkTo(doorPort: number, pidFile: string, end: { dir?: string; platform?: NodeJS.Platform } = {}) {
    const file = path.join(tmp(), 'cloud-link.json');
    const profile: ServerProfile = {
      id: 's_1a2b3c4d', host: 'ubuntu@100.101.245.29', runner: { kind: 'docker', container: 'tars-server', sudo: true }, doorSocket: REMOTE,
      serverId: SERVER_ID, name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL,
    };
    saveProfile(file, profile);
    const calls: ServerCommand[] = [];
    const dir = end.dir ?? path.join(tmp(), 'cloud');
    const link = createCloudLink({
      file,
      run: async (_p, command): Promise<RunResult> => {
        calls.push(command);
        return { ok: true, json: { running: true, serverId: SERVER_ID, name: 'srv1539916', door: '/home/tars/.tars-private/door.sock' } };
      },
      hostname: () => 'PC-Nicolas',
      forward: async (p, remoteSocket) => openForward(p.host, await localForwardEnd(p.id, { dir, platform: end.platform }), remoteSocket, {
        ssh: FAKE_SSH, env: { ...process.env, FAKE_SSH_FORWARD_TO: String(doorPort), FAKE_SSH_PID_FILE: pidFile },
      }),
      client: createDoorClient,
    });
    cleanup.push(() => link.disconnect(profile.id));
    return { link, profile, calls };
  }

  it('hello with another server id never gets the credential', async () => {
    const door = await startDoor('aaaaaaaaaaaaaaaa');
    const pidFile = path.join(tmp(), 'pid');
    const t = linkTo(door.port, pidFile);
    await t.link.connect(t.profile.id);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'another-server' });
    expect(door.seen.map(s => s.url)).toEqual(['/cloud/v1/hello']);
    expect(door.seen.every(s => s.authorization === undefined)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  });

  it('a local end that is not ours fails the connect before any ssh', async () => {
    const door = await startDoor(SERVER_ID);
    const dir = path.join(tmp(), 'cloud');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 's_1a2b3c4d.sock'), 'not ours');
    const pidFile = path.join(tmp(), 'pid');
    const t = linkTo(door.port, pidFile, { dir, platform: 'linux' });
    await t.link.connect(t.profile.id);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', sentence: expect.stringMatching(/not a socket/) });
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(door.seen).toEqual([]);
  });

  it("a door that is not there is not connected", async () => {
    const door = await startDoor(SERVER_ID);
    const unused = door.port;
    cleanup.pop()!();
    const pidFile = path.join(tmp(), 'pid');
    const t = linkTo(unused, pidFile);
    await t.link.connect(t.profile.id);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'no-door' });
  });

  it('closing the link ends the local ssh only', async () => {
    const door = await startDoor(SERVER_ID);
    const pidFile = path.join(tmp(), 'pid');
    const t = linkTo(door.port, pidFile);
    await t.link.connect(t.profile.id);
    expect(t.link.state(t.profile.id).phase).toBe('connected');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    t.link.disconnect(t.profile.id);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(false);
    expect(t.calls).toEqual([{ do: 'status' }]);
    expect(t.link.state(t.profile.id).phase).toBe('off');
  });
});
