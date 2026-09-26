import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The run's own temp dir: one folder in the machine's, which every test file
 * takes for its temp dir and which goes when the run ends.
 *
 * Measured on Windows on 2026-09-25: a full `npm test` left 117 folders in
 * %TEMP% (131 before this lot), from some sixty files that make one and never
 * remove it, and from any file whose tests are all skipped, which runs none of
 * its hooks: home-isolation.ts's afterAll included, so its throwaway HOME
 * stayed too. macOS and Linux keep the same folders in their temp dir. A
 * global setup runs once, in the runner's own process, and its teardown runs
 * whatever the files did; the workers are started after it and inherit the
 * variables it sets, so os.tmpdir() in every test, and in every program a test
 * starts, is this folder.
 *
 * TMPDIR is what os.tmpdir() reads on macOS and Linux, TEMP then TMP on
 * Windows. Each is put back as it was before the folder is removed.
 *
 * On Windows the folder is made under the canonical spelling of the temp dir.
 * CI's windows-latest runs as runneradmin, whose %TEMP% is the 8.3 short
 * C:\Users\RUNNER~1\AppData\Local\Temp; git, and every program that
 * canonicalises, report C:\Users\runneradmin\..., and Claude's folder name for
 * a project under RUNNER~1 (RUNNER-1) cannot be read back to that folder. Seen
 * on 2026-09-26 in CI run 36232894943: 15 tests (release, release:win, the
 * purge, the Claude project decoder and its readers) compared the short
 * spelling with the long one. A %TEMP% spelled in another case, or reached
 * through a junction, differs from its canonical spelling the same way.
 * fs.realpathSync.native expands a short name, the case and a junction;
 * fs.realpathSync does not expand a short name or the case. darwin and linux
 * keep their temp dir as it is spelled (/var/folders on macOS, which is behind
 * the /private link): their tests were written and measured against it.
 */
const TEMP_VARIABLES = ['TMPDIR', 'TEMP', 'TMP'] as const;

/** Where the run's folder is made: the machine's temp dir, canonical on Windows. */
export function runDirParent(tmp: string = os.tmpdir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? fs.realpathSync.native(tmp) : tmp;
}

export default function setup(): () => void {
  const dir = fs.mkdtempSync(path.join(runDirParent(), 'tars-vitest-run-'));
  const saved = Object.fromEntries(TEMP_VARIABLES.map(key => [key, process.env[key]]));
  for (const key of TEMP_VARIABLES) process.env[key] = dir;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}
