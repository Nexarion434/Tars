import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * One Tars server per data folder, and never a server on a folder a Tars
 * already runs on: two processes writing the same agents.json lose agents.
 *
 * The record lives in PRIVATE_DIR (server.json, 0600): the pid, the local
 * API's port, the version, when and by what it was started. `tars-server
 * status` reads it, and so does a desktop's link over SSH. A record whose pid
 * is gone is a server that died: the next start takes it over.
 */

export interface ServerRecord {
  pid: number;
  apiPort: number;
  version: string;
  startedAt: string;
  /** systemd (a unit), cli (`tars-server start`), shell (run by hand, or a container's entry). */
  startedBy: 'systemd' | 'cli' | 'shell';
  /** The door's socket, once it listens (recordDoor). */
  door?: string;
}

export type Claim =
  | { ok: true; release(): void }
  | { ok: false; heldBy: 'server'; pid: number; apiPort: number }
  | { ok: false; heldBy: 'tars'; apiPort: number };

export type ServerStatus = { running: false } | ({ running: true } & ServerRecord);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readServerRecord(file: string): ServerRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ServerRecord>;
    if (!Number.isInteger(raw.pid) || !Number.isInteger(raw.apiPort) || typeof raw.version !== 'string') return null;
    return raw as ServerRecord;
  } catch {
    return null;
  }
}

/** Whether a Tars answers /api/health on this port (it needs no token), within timeoutMs. */
export function answersHealth(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Whether a pid is a running Tars server of this install: alive, and, where /proc shows it, running this
 * checkout's own server entry (an argument that resolves, from that process's folder, to SERVER_ENTRIES), so a pid
 * the system gave to another program, or to another checkout's server, blocks no restart.
 */
export const SERVER_ENTRIES = ['main.js', 'cli.js'].map(name => path.join(__dirname, name));

export function isServerPid(pid: number, procRoot = '/proc', entries: readonly string[] = SERVER_ENTRIES): boolean {
  if (!pidAlive(pid)) return false;
  let cmdline: string;
  try {
    cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf-8');
  } catch {
    return true;
  }
  let cwd = '/';
  try { cwd = fs.readlinkSync(`${procRoot}/${pid}/cwd`); } catch { /* relative arguments then resolve from / */ }
  return cmdline.split(String.fromCharCode(0)).some(arg => arg !== '' && entries.includes(path.resolve(cwd, arg)));
}

/**
 * The record made whole first, in a file of its own, then linked to its name: link fails if the name exists, so
 * two servers starting at once cannot both take the folder, and no reader ever sees half a record.
 */
function writeExclusive(file: string, text: string): boolean {
  // A first start: the private folder is made here, for its owner alone, as writeSecretFileSync makes it.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function claimDataFolder(opts: {
  file: string;
  apiPort: number;
  record: Omit<ServerRecord, 'pid' | 'apiPort'>;
  procRoot?: string;
  entries?: readonly string[];
}): Promise<Claim> {
  if (await answersHealth(opts.apiPort)) return { ok: false, heldBy: 'tars', apiPort: opts.apiPort };
  const text = `${JSON.stringify({ ...opts.record, pid: process.pid, apiPort: opts.apiPort })}\n`;
  const live = (record: ServerRecord | null): record is ServerRecord =>
    record !== null && record.pid !== process.pid && isServerPid(record.pid, opts.procRoot, opts.entries);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writeExclusive(opts.file, text)) {
      return {
        ok: true,
        release: () => {
          if (readServerRecord(opts.file)?.pid === process.pid) fs.rmSync(opts.file, { force: true });
        },
      };
    }
    const existing = readServerRecord(opts.file);
    if (live(existing)) return { ok: false, heldBy: 'server', pid: existing.pid, apiPort: existing.apiPort };
    // A stale record is moved aside, then what was moved is checked: a live server may have replaced the stale
    // record between the read above and the move. Its record is then put back (link: never over another) and
    // the claim refused; a stale one is dropped and the create tried again.
    const aside = `${opts.file}.${process.pid}.stale`;
    try {
      fs.renameSync(opts.file, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const moved = readServerRecord(aside);
    if (live(moved)) {
      try { fs.linkSync(aside, opts.file); } catch { /* a third record is there: it stands */ }
      fs.rmSync(aside, { force: true });
      return { ok: false, heldBy: 'server', pid: moved.pid, apiPort: moved.apiPort };
    }
    fs.rmSync(aside, { force: true });
  }
  return { ok: false, heldBy: 'server', pid: 0, apiPort: opts.apiPort };
}

/** Adds the door's socket to this server's record, for status. */
export function recordDoor(file: string, door: string): void {
  const record = readServerRecord(file);
  if (record?.pid !== process.pid) return;
  writeSecretFileSync(file, `${JSON.stringify({ ...record, door })}
`);
}

export function serverStatus(file: string): ServerStatus {
  const record = readServerRecord(file);
  return record && isServerPid(record.pid) ? { running: true, ...record } : { running: false };
}

/** What a refused claim says, on stderr, before the server exits 1. */
export function refusal(claim: Exclude<Claim, { ok: true }>, dataDir: string): string {
  return claim.heldBy === 'server'
    ? `tars-server: another Tars server (pid ${claim.pid}) already runs on ${dataDir}; one server per data folder.`
    : `tars-server: a Tars already answers on port ${claim.apiPort} for ${dataDir}; a server never shares a data folder with another Tars.`;
}
