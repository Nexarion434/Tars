import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * Where a Tars server's door listens: a Unix socket in the private folder
 * (0600 in 0700), reached by a desktop through `ssh -L 127.0.0.1:<local>:<this
 * path>`. Not a loopback port: any local process, another account, or a
 * container on the host's network could bind that port while the server is
 * down, answer /hello with the real server's id and collect credentials (the
 * review of 6096a87d, blocking finding 1). A path in a folder only the
 * server's user can enter cannot be taken by anyone else.
 *
 * Windows runs no Tars server; there the door is a named pipe, for the tests.
 */

const PIPE_PREFIX = ['', '', '.', 'pipe', ''].join('\\');

export function doorSocketPath(privateDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const key = crypto.createHash('sha256').update(privateDir).digest('hex').slice(0, 16);
    return `${PIPE_PREFIX}tars-door-${key}`;
  }
  return path.posix.join(privateDir, 'door.sock');
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

/**
 * Makes the socket's path ready to listen on, or throws saying why not: its
 * folder must be a real folder (not a link), owned by this user, entered by no
 * one else (0700); at the path itself, a link or anything but a socket is
 * refused and left as it is (never followed, never removed); a socket another
 * door answers on is refused; a socket no one answers on (left by a killed
 * server) is removed.
 */
export async function prepareDoorSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') {
    if (!socketPath.startsWith(PIPE_PREFIX)) throw new Error(`On Windows the door is a named pipe, not ${socketPath}.`);
    return;
  }
  const dir = path.dirname(socketPath);
  const folder = fs.lstatSync(dir);
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error(`The door's folder ${dir} is a link or not a folder.`);
  if (typeof process.getuid === 'function' && folder.uid !== process.getuid()) throw new Error(`The door's folder ${dir} belongs to another user.`);
  if ((folder.mode & 0o077) !== 0) throw new Error(`The door's folder ${dir} lets others in: it must be 0700.`);

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!existing) return;
  if (!existing.isSocket()) throw new Error(`${socketPath} is not a socket (a link or a file): left as it is, the door does not open.`);
  if (await answers(socketPath)) throw new Error(`A door already listens on ${socketPath}.`);
  fs.rmSync(socketPath);
}

/** Once listening: the socket for its owner alone (the folder already keeps others out). */
export function closeDoorSocket(socketPath: string): void {
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
}
