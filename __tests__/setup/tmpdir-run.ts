import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDirParent } from './run-dir';
import { endLeftUnder, type Found } from './leftover-processes';

/**
 * The run's own temporary folder, and the guard that it is empty at the end.
 *
 * vitest runs this once, in its main process, before it starts the workers, so
 * the workers and everything they start inherit the folder through TMPDIR,
 * TMP and TEMP. Each test file then makes its own folder inside it and removes
 * it when it ends (tmpdir-isolation.ts). At the end of the run, anything still
 * in the folder is a file's folder that outlived the file, or something written
 * past the file's own folder, and the run fails with its names. It is removed
 * either way, so that a failed run does not leave its leftovers behind as well.
 *
 * One kind of entry is not a leak: the folder of a file skipped whole, which
 * ran no hooks and so could not remove it. It is the one file folder without
 * the mark tmpdir-isolation.ts leaves when a file's hooks run, and the run
 * removes it with its own.
 *
 * Why the run fails rather than warns: 312 entries a run were left on
 * 2026-10-01, a day of that filled a disk, and no one had read a warning.
 *
 * The processes started from the folder are looked at too, before it goes, and
 * one still running fails the run, ended first, stopped or not
 * (leftover-processes.ts). On 2026-10-19, 130 fake ACP agents were found
 * stopped, started from runs' folders long removed: a delegated run's stop
 * sends SIGSTOP and reads ps before its SIGTERM and SIGCONT, and a worker that
 * ended in between left them so. What a test starts by way of the code under
 * test, the test ends in its own teardown; this is the witness that it did.
 */

const VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;
/** As tmpdir-isolation.ts names a file's folder, and the mark it leaves there. */
const FILE_PREFIX = 'tars-vitest-file-';
const MARK = 'tars-vitest-hooks-ran';
/** How long a process still running at the end gets to end on its own: the workers' children read the end of their stdin. */
const LEFT_GRACE_MS = 2_000;

/** The folder of a test file whose hooks never ran: skipped whole, or never started. */
function ranNoHooks(entry: string): boolean {
  return path.basename(entry).startsWith(FILE_PREFIX) && !fs.existsSync(path.join(entry, MARK));
}

export default function setup(): () => Promise<void> {
  const before = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
  // On Windows under the temp dir's canonical spelling (run-dir.ts says why: RUNNER~1 on CI).
  const run = fs.mkdtempSync(path.join(runDirParent(), 'tars-vitest-run-'));
  for (const name of VARIABLES) process.env[name] = run;

  return async () => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    let ended: Found[] = [];
    let left: string[] = [];
    try {
      // Before the folder goes: on Windows a process working in it holds it.
      ended = await endLeftUnder(run, LEFT_GRACE_MS);
      left = fs.readdirSync(run).filter(name => !ranNoHooks(path.join(run, name)));
    } finally {
      // Retried, as tmpdir-isolation.ts removes a file's folder and for the
      // same reason: rmSync does not retry a folder Windows refuses to remove
      // while a process ending has it as its working directory.
      await fs.promises.rm(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    const said: string[] = [];
    if (ended.length > 0) {
      const shown = ended.slice(0, 20).map(({ pid, state, command }) => `${pid} ${state} ${command}`).join('; ');
      said.push(
        `The run left ${ended.length} process${ended.length === 1 ? '' : 'es'} running from its temporary folder, now ended: ${shown}${ended.length > 20 ? '; ...' : ''}. `
        + 'What a test starts by way of the code under test, the test ends in its own teardown, stopped or not (__tests__/setup/leftover-processes.ts).',
      );
    }
    if (left.length > 0) {
      const shown = left.slice(0, 20).join(', ');
      said.push(
        `The run left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temporary folder (${shown}${left.length > 20 ? ', ...' : ''}). `
        + 'A test file\'s folder must go when the file ends (__tests__/setup/tmpdir-isolation.ts), and nothing may be written past it.',
      );
    }
    if (said.length > 0) {
      // vitest 4.1 logs an error thrown here as "error during close" and still
      // exits 0 (measured on the witness run): the exit code is set by hand.
      process.exitCode = 1;
      throw new Error(said.join(' '));
    }
  };
}
