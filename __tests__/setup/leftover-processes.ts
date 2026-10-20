import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The processes a test started by way of the code under test, which it ends
 * afterwards by id in case that code did not: `leftovers.push(pid)` while they
 * run, `leftovers.end()` in afterEach.
 *
 * Most of them are gone by then: ending them is what the code under test is
 * for. On Windows the id of a process that has exited is free at once, and
 * Windows hands ids out again soon (freed ids first, in small numbers on a
 * fresh machine); a kill sent to it by id is a TerminateProcess of whatever
 * holds it now: on CI's windows-latest, an administrator, any process at all,
 * a vitest worker included. So on win32 an id is ended only when the process
 * holding it was created no later than the test saw it: the one the test
 * meant, not one started since. Nothing is asked of PowerShell when no id is
 * held any more, which is how a passing test ends.
 *
 * darwin and linux hand ids out in sequence and reuse one only once the range
 * has wrapped: every id is signalled there, as the tests always did. On every
 * platform an id that is not a positive integer is never signalled: 0 is the
 * caller's own process group (its own process on Windows), and -1 every
 * process the account may signal.
 */
export class Leftovers {
  private seen: Array<{ pid: number; at: number }> = [];

  /** `now` is the clock the ids are seen by: Date.now, or a witness's. */
  constructor(private readonly now: () => number = Date.now) {}

  push(...pids: number[]): number {
    const at = this.now();
    for (const pid of pids) if (Number.isSafeInteger(pid) && pid > 0) this.seen.push({ pid, at });
    return this.seen.length;
  }

  end(): void {
    const seen = this.seen.splice(0);
    if (process.platform !== 'win32') {
      for (const { pid } of seen) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      return;
    }
    const held = seen.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (held.length === 0) return;
    const created = creationTimes(held.map(({ pid }) => pid));
    for (const { pid, at } of held) {
      const when = created.get(pid);
      // Gone since, or someone else's: not ours to end.
      if (when === undefined || when > at) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** win32: when each process was created, in ms since the epoch, from Win32_Process. The filter holds numbers only. */
function creationTimes(pids: number[]): Map<number, number> {
  const filter = pids.map(pid => `ProcessId=${Math.trunc(pid)}`).join(' OR ');
  const out = execFileSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`],
  { windowsHide: true, timeout: 60_000 }).toString();
  return new Map(out.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(' ').map(Number) as [number, number]));
}

/**
 * A fake agent is started by the code under test, so the test never sees its
 * id: this, the first line of its script, records it beside the script, and
 * the test's teardown takes it (takePidsRecordedIn) and ends it, stopped or not
 * (Leftovers). Plain JavaScript, for a module and a script alike.
 */
export const RECORDS_ITS_PID = "process.getBuiltinModule('node:fs').appendFileSync(process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.argv[1]), 'fake-agent.pids'), process.pid + '\\n');\n";
const PIDS_FILE = 'fake-agent.pids';

/** The ids the fake agents started from `dir` recorded since the last take: each is given once, never ended twice. */
export function takePidsRecordedIn(dir: string): number[] {
  const file = path.join(dir, PIDS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

/** A live process: its id, its state as ps reads it ('-' on win32, which has none), and its command line. */
export type Found = { pid: number; state: string; command: string };

/**
 * Every live process whose command line names `dir` as a path: followed by a
 * separator, a space, a quote or the end, so that run-10's are not run-1's. A
 * zombie has no command line left (ps shows `<defunct>` on macOS and Linux),
 * and is skipped where one would show. darwin and linux read ps, as
 * acp/client.ts does; win32 reads Win32_Process.
 */
export function processesUnder(dir: string): Found[] {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`${escaped}(?=[\\\\/\\s"']|$)`, process.platform === 'win32' ? 'i' : '');
  return processRows().filter(row => names.test(row.command) && !row.state.startsWith('Z'));
}

function processRows(): Found[] {
  const out = process.platform === 'win32'
    ? execFileSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) - $($_.CommandLine)" }'],
    { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
    : execFileSync('ps', ['-A', '-ww', '-o', 'pid=,stat=,command='], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return out.toString().split(/\r?\n/).flatMap(line => {
    const row = /^\s*(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    return row ? [{ pid: Number(row[1]), state: row[2], command: row[3].trim() }] : [];
  });
}

/**
 * What still runs from `dir`, ended before this returns, and named: the run's
 * guard at its end (tmpdir-run.ts). A process that ends on its own within
 * `graceMs` is not left: as a run ends, its workers' children read the end of
 * their stdin and go. A stopped one never will, and is not waited for. SIGKILL,
 * which ends a stopped process too: a SIGTERM would wait for a SIGCONT. On
 * win32, where nothing is stopped, process.kill terminates the process.
 */
export async function endLeftUnder(dir: string, graceMs: number): Promise<Found[]> {
  const stopped = (row: Found) => row.state.startsWith('T');
  const graceEnds = Date.now() + graceMs;
  let left = processesUnder(dir);
  while (left.some(row => !stopped(row)) && Date.now() < graceEnds) {
    await new Promise(resolve => setTimeout(resolve, 100));
    left = processesUnder(dir);
  }
  for (const { pid } of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone since */ } }
  const goneBy = Date.now() + 5_000;
  while (left.length > 0 && processesUnder(dir).length > 0 && Date.now() < goneBy) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return left;
}
