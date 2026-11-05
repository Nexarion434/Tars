import { describe, it, expect } from 'vitest';
import { sshClient } from '../../../electron/platform/ssh-client';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * The `ssh` the cloud link runs (platform/ssh-client.ts).
 *
 * How it fails, written before the code (2026-11-03). Tars started from Git
 * Bash ran Git's MSYS `ssh`, first on that PATH, which reads $HOME and not the
 * Windows profile: it found no known_hosts and Settings > Cloud said "This
 * computer has never connected to ...", although Windows' own OpenSSH, whose
 * keys and known_hosts the user set up, knew the server.
 * 1. win32: a bare `ssh` (looked up on the PATH, Git's first there) while
 *    Windows' own OpenSSH is in %SystemRoot%\System32\OpenSSH.
 * 2. win32: %SystemRoot% spelled another way (SYSTEMROOT) not read, or unset
 *    and not taken as C:\Windows.
 * 3. win32: without Windows' OpenSSH (not installed), anything but `ssh` on
 *    the PATH, the client the user installed.
 * 4. darwin/linux: anything but `ssh`, or the disk touched.
 */

const OWN = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const files = (present: string[]): FsProbe => ({
  isFile: p => present.map(f => f.toLowerCase()).includes(p.toLowerCase()),
  readFile: () => { throw new Error('read a file'); },
});
const noFs: FsProbe = {
  isFile: () => { throw new Error('touched the disk'); },
  readFile: () => { throw new Error('touched the disk'); },
};
const gitFirst = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32\\OpenSSH' };

describe('sshClient', () => {
  it('1. win32: Windows\' own OpenSSH when it is there, whatever comes first on the PATH', () => {
    expect(sshClient({ platform: 'win32', env: gitFirst, fs: files([OWN]) })).toBe(OWN);
  });

  it('2. win32: %SystemRoot% in any spelling, C:\\Windows when unset', () => {
    expect(sshClient({ platform: 'win32', env: { SYSTEMROOT: 'D:\\Win' }, fs: files(['D:\\Win\\System32\\OpenSSH\\ssh.exe']) }))
      .toBe('D:\\Win\\System32\\OpenSSH\\ssh.exe');
    expect(sshClient({ platform: 'win32', env: {}, fs: files([OWN]) })).toBe(OWN);
  });

  it('3. win32: `ssh` on the PATH when Windows\' OpenSSH is not installed', () => {
    expect(sshClient({ platform: 'win32', env: gitFirst, fs: files([]) })).toBe('ssh');
  });

  it.each(['darwin', 'linux'] as const)('4. %s: `ssh`, the disk untouched', (platform) => {
    expect(sshClient({ platform, env: { PATH: '/usr/bin' }, fs: noFs })).toBe('ssh');
  });
});
