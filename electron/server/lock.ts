import * as fs from 'fs';
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

export async function claimDataFolder(opts: {
  file: string;
  apiPort: number;
  record: Omit<ServerRecord, 'pid' | 'apiPort'>;
}): Promise<Claim> {
  const existing = readServerRecord(opts.file);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { ok: false, heldBy: 'server', pid: existing.pid, apiPort: existing.apiPort };
  }
  if (await answersHealth(opts.apiPort)) return { ok: false, heldBy: 'tars', apiPort: opts.apiPort };
  writeSecretFileSync(opts.file, `${JSON.stringify({ ...opts.record, pid: process.pid, apiPort: opts.apiPort })}\n`);
  return {
    ok: true,
    release: () => {
      if (readServerRecord(opts.file)?.pid === process.pid) fs.rmSync(opts.file, { force: true });
    },
  };
}

export function serverStatus(file: string): ServerStatus {
  const record = readServerRecord(file);
  return record && pidAlive(record.pid) ? { running: true, ...record } : { running: false };
}

/** What a refused claim says, on stderr, before the server exits 1. */
export function refusal(claim: Exclude<Claim, { ok: true }>, dataDir: string): string {
  return claim.heldBy === 'server'
    ? `tars-server: another Tars server (pid ${claim.pid}) already runs on ${dataDir}; one server per data folder.`
    : `tars-server: a Tars already answers on port ${claim.apiPort} for ${dataDir}; a server never shares a data folder with another Tars.`;
}
