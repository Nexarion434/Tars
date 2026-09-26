import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A file this account cannot read, or a folder it cannot add a file to, for
 * the tests about a read or a write that fails, and what gives it back.
 *
 * macOS and Linux: the mode, then `restoreMode`, as those tests always did.
 * Windows has no mode bits: chmod only sets the read-only attribute, which a
 * folder ignores, and which leaves a file readable while refusing writes and a
 * rename over it, so a test built on it sees nothing fail, or a failure it
 * never meant to cause. There an access control entry denies this account the
 * one right in question (icacls), and nothing more: a file denied its data
 * still gives its size, times and id and can still be replaced, as with mode
 * 0000; a folder denied new files still lists and still reads. The failure
 * there is EPERM where POSIX says EACCES.
 */

const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');

function deny(target: string, rights: string): () => void {
  const account = os.userInfo().username;
  execFileSync(ICACLS, [target, '/deny', `${account}:(${rights})`], { stdio: 'pipe' });
  return () => {
    execFileSync(ICACLS, [target, '/remove:d', account], { stdio: 'pipe' });
  };
}

/** `file` unreadable: mode 0000, or on Windows its data denied (RD). */
export function makeUnreadable(file: string, restoreMode = 0o644): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o000);
    return () => fs.chmodSync(file, restoreMode);
  }
  return deny(file, 'RD');
}

/** No new file in `dir`: mode 0500, or on Windows adding a file denied (WD). */
export function makeUnwritable(dir: string, restoreMode = 0o700): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o500);
    return () => fs.chmodSync(dir, restoreMode);
  }
  return deny(dir, 'WD');
}
