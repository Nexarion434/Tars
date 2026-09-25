import * as fs from 'fs';

/**
 * Renaming a finished temp file over the live one, the last step of every
 * atomic write (audit B S-02).
 *
 * darwin/linux: one fs.renameSync, as before; a reader never stands in its way.
 *
 * win32: the rename fails with EPERM, EBUSY or EACCES while any process holds
 * the target open, even to read it (measured on this machine: 198 of 200
 * renames failed under 20 Node readers). Readers here are Claude Code opening
 * ~/.claude.json, an MCP server reading app-settings.json, an antivirus
 * scanning a file that just changed: each holds it for a moment. So the rename
 * is tried again, quickly at first and then less often, for about a second,
 * and if the file is still held after that, the error says which file, for
 * how long, and keeps its code. Any other error (the temp file gone, another
 * volume, a full disk) is thrown at once: no reader causes it and waiting
 * would only hide it.
 *
 * The wait blocks the calling thread, as the synchronous write around it does:
 * callers are synchronous and a second at worst is the price of not losing a
 * save.
 */
export const RENAME_RETRY_BUDGET_MS = 1000;

const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RenameDeps {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
  now?: () => number;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const blockFor = (ms: number) => { Atomics.wait(pause, 0, 0, ms); };

export function renameReplacingSync(from: string, to: string, deps: RenameDeps = {}): void {
  const rename = deps.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  if ((deps.platform ?? process.platform) !== 'win32') {
    rename(from, to);
    return;
  }
  const sleep = deps.sleep ?? blockFor;
  const now = deps.now ?? Date.now;
  const started = now();
  let wait = 1;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const spent = now() - started;
      if (!code || !HELD.has(code)) throw err;
      if (spent >= RENAME_RETRY_BUDGET_MS) {
        const e = err as NodeJS.ErrnoException;
        e.message = `Could not replace ${to}: it was held open by another program for ${spent} ms (${code}). ${e.message}`;
        throw e;
      }
      sleep(Math.min(wait, RENAME_RETRY_BUDGET_MS - spent));
      wait = Math.min(wait * 2, 50);
    }
  }
}
