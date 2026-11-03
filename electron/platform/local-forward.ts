import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * Where the desktop's end of a Tars server's SSH forward listens
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 5).
 *
 * darwin/linux: a Unix socket in `dir` (PRIVATE_DIR/cloud, made 0700), which
 * no other account can open. A socket left there by an `ssh` that was killed
 * is ours, and removed; anything else at that path is not, and is left, and
 * the forward refused.
 *
 * win32: a free port on 127.0.0.1. Another account of the same PC can race
 * for that port between this choice and `ssh`'s bind; the link sends the
 * credential only once `ssh` holds the port and the door behind it answers
 * with the expected server id (SECURITY.md says what is left).
 */

export type LocalForwardEnd = { kind: 'unix'; path: string } | { kind: 'tcp'; port: number };

const KEY = /^[A-Za-z0-9_-]{1,32}$/;

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No loopback port was free.'))));
    });
  });
}

export async function localForwardEnd(serverKey: string, opts: { dir: string; platform?: NodeJS.Platform }): Promise<LocalForwardEnd> {
  if (!KEY.test(serverKey)) throw new Error(`${JSON.stringify(serverKey)} cannot name a forward.`);
  if ((opts.platform ?? process.platform) === 'win32') return { kind: 'tcp', port: await freeLoopbackPort() };
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(opts.dir, 0o700);
  const socket = path.join(opts.dir, `${serverKey}.sock`);
  let found: fs.Stats | null = null;
  try {
    found = fs.lstatSync(socket);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (found && !found.isSocket()) throw new Error(`${socket} is not a socket Tars left: it stays as it is, and this server's forward does not start.`);
  if (found) fs.unlinkSync(socket);
  return { kind: 'unix', path: socket };
}
