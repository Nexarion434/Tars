import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';

/**
 * The `ssh` the cloud link runs (services/cloud-link/ssh.ts spawnSsh).
 *
 * win32: Windows' own OpenSSH, %SystemRoot%\System32\OpenSSH\ssh.exe, when it
 * is there: the client the user's keys and known_hosts belong to, under
 * their Windows profile. A bare `ssh` took the first one on the PATH, and a
 * Tars started from Git Bash has Git's MSYS `ssh` first there, which reads
 * $HOME instead, found no known_hosts and made Settings > Cloud say the
 * computer had never connected to a server it knew (2026-11-03). Looked up
 * by its absolute path, as kill-tree.ts and owner-only.ts do their System32
 * tools. Without it (the optional feature not installed), `ssh` on the PATH,
 * the client the user installed.
 *
 * darwin/linux: `ssh` on the PATH, as before, the disk untouched.
 */
export function sshClient(opts: { platform?: NodeJS.Platform; env?: Env; fs?: FsProbe } = {}): string {
  if ((opts.platform ?? process.platform) !== 'win32') return 'ssh';
  const systemRoot = envValue(opts.env ?? process.env, 'SystemRoot', 'win32') || 'C:\\Windows';
  const own = path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
  return (opts.fs ?? realFs).isFile(own) ? own : 'ssh';
}
