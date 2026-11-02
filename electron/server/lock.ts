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
 * Whether a pid is a running Tars server: alive, and, where /proc shows it, running a server's entry, so a pid the
 * system gave to another program after a crash blocks no restart.
 */
export function isServerPid(pid: number, procRoot = '/proc'): boolean {
  if (!pidAlive(pid)) return false;
  let cmdline: string;
  try {
    cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf-8');
  } catch {
    return true;
  }
  return /server[/\\](?:main|cli)\.js/.test(cmdline);
}

function writeExclusive(file: string, text: string): boolean {
  // A first start: the private folder is made here, for its owner alone, as writeSecretFileSync makes it.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function claimDataFolder(opts: {
  file: string;
  apiPort: number;
  record: Omit<ServerRecord, 'pid' | 'apiPort'>;
  procRoot?: string;
}): Promise<Claim> {
  if (await answersHealth(opts.apiPort)) return { ok: false, heldBy: 'tars', apiPort: opts.apiPort };
  const text = `${JSON.stringify({ ...opts.record, pid: process.pid, apiPort: opts.apiPort })}
`;
  // Created exclusively (O_EXCL): two servers starting at once cannot both take the folder. A record left by a
  // server that is gone is removed once, then the create is tried again.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeExclusive(opts.file, text)) {
      return {
        ok: true,
        release: () => {
          if (readServerRecord(opts.file)?.pid === process.pid) fs.rmSync(opts.file, { force: true });
        },
      };
    }
    const existing = readServerRecord(opts.file);
    if (existing && existing.pid !== process.pid && isServerPid(existing.pid, opts.procRoot)) {
      return { ok: false, heldBy: 'server', pid: existing.pid, apiPort: existing.apiPort };
    }
    fs.rmSync(opts.file, { force: true });
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
