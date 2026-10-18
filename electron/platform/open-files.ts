import * as fs from 'fs';
import { execFile } from 'child_process';

/**
 * The files some processes hold open, by their real paths: what tells Tars that a new codex session is the one the
 * agent's own codex writes, when its first message does not say whose it is (services/codex-sessions.ts, the Audit's
 * M1 on #465). Measured on codex-cli 0.163.0: codex holds its rollout open from its first line to its end, at rest
 * included, and lsof answers in 100 to 160 ms.
 *
 * darwin: lsof, asked for these pids only, which names each file by its real path. linux: /proc/<pid>/fd, a link to
 * each file. win32: no tool of Windows's own lists a process's files, so it is unknown: undefined, never an empty set,
 * which would read as "none of them holds it". A lsof that fails or hangs is unknown too; a pid that is no process
 * holds nothing, and takes nothing from the others asked with it.
 */
export function openFilesReadable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

export async function filesOpenBy(pids: number[], platform: NodeJS.Platform = process.platform): Promise<Set<string> | undefined> {
  if (!openFilesReadable(platform)) return undefined;
  const asked = pids.filter(pid => Number.isInteger(pid) && pid > 0);
  return platform === 'linux' ? fromProc(asked) : fromLsof(asked);
}

function fromProc(pids: number[]): Set<string> {
  const names = new Set<string>();
  for (const pid of pids) {
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // gone, or another account's
    for (const fd of fds) {
      try { names.add(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed meanwhile */ }
    }
  }
  return names;
}

function fromLsof(pids: number[]): Promise<Set<string> | undefined> {
  if (pids.length === 0) return Promise.resolve(new Set());
  return new Promise(done => {
    // -w no warnings, -n -P no name or port lookups, -Fn names only.
    execFile('lsof', ['-w', '-n', '-P', '-Fn', '-p', pids.join(',')], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout ?? '');
      // lsof exits 1 when a pid asked is no process, and lists the others' files all the same.
      if (err && !(typeof (err as { code?: unknown }).code === 'number' && (err as { code: number }).code === 1)) {
        done(undefined);
        return;
      }
      done(new Set(namesFromLsof(out)));
    });
  });
}

/** The file names in lsof's -F output: its `n` lines, whole. */
export function namesFromLsof(out: string): string[] {
  return out.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
}
