import { execFileSync, spawn } from 'node:child_process';
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

/**
 * `file` unreadable to every process, whatever its privileges, until the
 * returned function is called: on Windows another process holds it open with
 * no sharing (FileShare.None), so each open for its data fails with a sharing
 * violation (EBUSY in Node), and sharing is enforced whatever the privileges.
 * The access control entry of makeUnreadable was not enough there: on CI's
 * windows-latest, whose account is an administrator, the E2E app read a file
 * denied that way and priced its turn (run 36242089925), while the unit tests'
 * own reads of one were refused. macOS and Linux: mode 0000, as makeUnreadable.
 */
export async function holdUnreadable(file: string, restoreMode = 0o644): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const restore = makeUnreadable(file, restoreMode);
    return async () => restore();
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$f = [IO.File]::Open($env:TARS_HOLD_FILE, 'Open', 'Read', 'None'); "
    + "[Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()";
  const holder = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, TARS_HOLD_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let said = '';
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on('data', chunk => { said += String(chunk); if (said.includes('held')) resolve(); });
    holder.stderr!.on('data', chunk => { said += String(chunk); });
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error(`the process holding ${file} exited (${code}) before it held it: ${said.trim()}`)));
  });
  return () => new Promise<void>(resolve => {
    holder.once('exit', () => resolve());
    holder.stdin!.end('\n');
  });
}
