import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { doorSocketPath, prepareDoorSocket } from '../../../electron/services/cloud/door-socket';

/**
 * Where the door listens (the review of 6096a87d, blocking finding 1): a Unix
 * socket in the private folder, which no other account and no other container
 * can take while the server is down, unlike a loopback port any local process
 * could bind first and answer with the real server's id. A desktop forwards to
 * it with `ssh -L 127.0.0.1:<local>:<socket path>`.
 *
 * How it fails (POSIX; on Windows, which runs no server, the door is a named pipe for the tests):
 * - a folder another account can enter, a folder that is a link, or a folder
 *   another user owns accepted
 * - a link at the socket's path followed, or a plain file there removed
 * - a live socket (another door) removed and taken over
 * - a stale socket (no one listening) left in the way
 */

const posix = process.platform !== 'win32';
const servers: net.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise(r => s.close(() => r(null))); });

function privateDir(mode = 0o700): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sock-')), 'private');
  fs.mkdirSync(dir, { mode });
  fs.chmodSync(dir, mode);
  return dir;
}

describe('doorSocketPath', () => {
  it('is door.sock in the private folder on POSIX, a named pipe on Windows', () => {
    const dir = '/home/tars/.tars-private';
    expect(doorSocketPath(dir, 'linux')).toBe(path.posix.join(dir, 'door.sock'));
    expect(doorSocketPath(dir, 'win32').startsWith(['', '', '.', 'pipe', ''].join('\\'))).toBe(true);
  });
});

describe.skipIf(!posix)('prepareDoorSocket', () => {
  it('accepts a folder only its owner can enter', async () => {
    await expect(prepareDoorSocket(path.join(privateDir(), 'door.sock'))).resolves.toBeUndefined();
  });

  it('refuses a folder others can enter', async () => {
    await expect(prepareDoorSocket(path.join(privateDir(0o755), 'door.sock'))).rejects.toThrow(/0700|others/);
  });

  it('refuses a folder that is a link', async () => {
    const real = privateDir();
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    await expect(prepareDoorSocket(path.join(link, 'door.sock'))).rejects.toThrow(/link/);
  });

  it('never follows a link at the socket\'s path, and leaves a plain file there', async () => {
    const dir = privateDir();
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, 'keep me');
    fs.symlinkSync(target, path.join(dir, 'door.sock'));
    await expect(prepareDoorSocket(path.join(dir, 'door.sock'))).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me');
    fs.rmSync(path.join(dir, 'door.sock'));
    fs.writeFileSync(path.join(dir, 'door.sock'), 'a file');
    await expect(prepareDoorSocket(path.join(dir, 'door.sock'))).rejects.toThrow(/not a socket/);
    expect(fs.existsSync(path.join(dir, 'door.sock'))).toBe(true);
  });

  it('refuses a socket another door listens on, and leaves it', async () => {
    const socket = path.join(privateDir(), 'door.sock');
    const other = net.createServer();
    servers.push(other);
    await new Promise<void>(r => other.listen(socket, () => r()));
    await expect(prepareDoorSocket(socket)).rejects.toThrow(/already listens/);
    expect(fs.existsSync(socket)).toBe(true);
  });

  it('removes a stale socket no one listens on', async () => {
    const socket = path.join(privateDir(), 'door.sock');
    const gone = net.createServer();
    await new Promise<void>(r => gone.listen(socket, () => r()));
    // Closed without removing its file, as a killed server leaves it.
    (gone as unknown as { _handle: { close(): void } | null })._handle?.close();
    await new Promise(r => setTimeout(r, 50));
    if (!fs.existsSync(socket)) return;
    await expect(prepareDoorSocket(socket)).resolves.toBeUndefined();
    expect(fs.existsSync(socket)).toBe(false);
  });
});
