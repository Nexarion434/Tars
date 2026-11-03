import { spawn, type ChildProcess, type StdioOptions } from 'child_process';
import type { LocalForwardEnd } from '../../platform/local-forward';

/**
 * The desktop's `ssh` calls to a Tars server (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md).
 * The system `ssh`, started without a shell, with the host after `--`.
 *
 * `ssh` hands its remote command to the remote user's shell as one string, so
 * the remote command here is built from words that read back as themselves in
 * any POSIX shell (and zsh): fixed words of Tars's own, and the user's words
 * (program, path, container) only once they pass the checks below. JSON input
 * travels on stdin; the only value on a command line is a client id, in the
 * server's own form.
 *
 * The forward's options are adapted from T3 Code's `packages/ssh/src/tunnel.ts`
 * (MIT, © 2026 T3 Tools Inc.), plus `BatchMode=yes`: a prompt nobody can
 * answer fails at once instead of hanging the connect.
 */

/** How the server's CLI is run on its host: a bare install, or inside its container. */
export type ServerRunner =
  | { kind: 'command'; argv: string[] }
  | { kind: 'docker'; container: string; sudo: boolean };

/** What the desktop asks a server over SSH; nothing else reaches its command line. */
export type ServerCommand =
  | { do: 'status' }
  | { do: 'start' }
  | { do: 'clients-add' }
  | { do: 'clients-list' }
  | { do: 'clients-revoke'; id: string };

/** The desktop's end of the forward: a loopback port, or a Unix socket of its own (platform/local-forward.ts). */
export type LocalEnd = LocalForwardEnd;

const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A word of the user's: no shell character, no leading `-` (an option), `=` (zsh's `=cmd`) or `~`. */
const USER_WORD = /^[A-Za-z0-9_./][A-Za-z0-9_@%+=:,./-]*$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CLIENT_ID = /^c_[0-9a-f]{8}$/;
/** A socket path `-L` reads as one: absolute, no `:` (its separator), no space or control. */
const SOCKET_PATH = /^\/[A-Za-z0-9_@%+=,./-]*$/;
/** A Unix socket address holds about 104 bytes on macOS, 108 on Linux. */
const MAX_LOCAL_SOCKET = 100;
/** Where the server's CLI is inside the image (scripts/server/build.sh, the container's working directory). */
const CONTAINER_CLI = ['node', 'electron/dist/server/cli.js'];

/** Why `host` cannot be given to `ssh`, in words, or null when it can. */
export function hostProblem(host: string): string | null {
  if (!host) return "Enter the server's SSH host: user@host, or an alias from your SSH config.";
  if (host.length > 255 || !HOST.test(host)) {
    return `${JSON.stringify(host)} is not an SSH host Tars can use: write user@host, or an alias from your SSH config, with no spaces or options.`;
  }
  return null;
}

/** Why `runner` cannot be put on a remote command line, in words, or null when it can. */
export function runnerProblem(runner: ServerRunner): string | null {
  if (runner.kind === 'docker') {
    return CONTAINER.test(runner.container) ? null : `${JSON.stringify(runner.container)} is not a Docker container name.`;
  }
  if (runner.argv.length === 0 || runner.argv.length > 8) return "Enter the command that runs the server's CLI, for instance node <install>/electron/dist/server/cli.js.";
  const bad = runner.argv.find(word => word.length > 255 || !USER_WORD.test(word));
  return bad === undefined ? null : `${JSON.stringify(bad)} cannot go on the server's command line: use letters, digits and / . _ - only, not starting with -.`;
}

function cliWords(command: ServerCommand): string[] {
  switch (command.do) {
    case 'status': return ['status', '--json'];
    case 'start': return ['start', '--json'];
    case 'clients-add': return ['clients', 'add', '--json'];
    case 'clients-list': return ['clients', 'list', '--json'];
    case 'clients-revoke':
      if (!CLIENT_ID.test(command.id)) throw new Error(`${JSON.stringify(command.id)} is not a client id of a Tars server.`);
      return ['clients', 'revoke', command.id];
  }
}

/** The remote command's words, checked: they read back as themselves in the remote shell. */
export function remoteWords(runner: ServerRunner, command: ServerCommand): string[] {
  const problem = runnerProblem(runner);
  if (problem) throw new Error(problem);
  if (runner.kind === 'command') return [...runner.argv, ...cliWords(command)];
  const sudo = runner.sudo ? ['sudo', '-n'] : [];
  // A stopped container is started as a container: the server inside comes up with it.
  if (command.do === 'start') return [...sudo, 'docker', 'start', runner.container];
  return [...sudo, 'docker', 'exec', '-i', runner.container, ...CONTAINER_CLI, ...cliWords(command)];
}

function checkedHost(host: string): string {
  const problem = hostProblem(host);
  if (problem) throw new Error(problem);
  return host;
}

/**
 * The options every call shares: no prompt, no shared connection left running
 * behind it, and nothing of the desktop handed to a host where agents run as
 * the same user (its ssh agent, its display, a local command), whatever the
 * user's ssh config says for that host (security review 1, nit 2).
 */
const COMMON = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
  '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
];

/** `ssh` arguments for one server command, its JSON input (if any) on stdin. No forward of the config binds for it. */
export function sshCommandArgv(host: string, runner: ServerRunner, command: ServerCommand): string[] {
  const words = remoteWords(runner, command);
  return [...COMMON, '-o', 'ClearAllForwardings=yes', '-T', '--', checkedHost(host), words.join(' ')];
}

function localSpec(end: LocalEnd): string {
  if (end.kind === 'tcp') {
    if (!Number.isInteger(end.port) || end.port < 1024 || end.port > 65535) throw new Error(`${end.port} is not a local port the forward can use.`);
    return `127.0.0.1:${end.port}`;
  }
  if (!/^\/[^:\s\u0000-\u001f]*$/.test(end.path) || end.path.length > MAX_LOCAL_SOCKET) {
    throw new Error(`${JSON.stringify(end.path)} cannot be the forward's local socket: an absolute path, no ':', ${MAX_LOCAL_SOCKET} characters at most.`);
  }
  return end.path;
}

/** Why `socket` cannot be the server's door socket on the SSH host, in words, or null when it can. */
export function remoteSocketProblem(socket: string): string | null {
  return SOCKET_PATH.test(socket) && socket.length <= 255 ? null : `${JSON.stringify(socket)} is not the path of the server's door socket.`;
}

/** `ssh` arguments for the long forward from the desktop's end to the server's door socket. */
export function sshForwardArgv(host: string, end: LocalEnd, remoteSocket: string): string[] {
  const problem = remoteSocketProblem(remoteSocket);
  if (problem) throw new Error(problem);
  return [
    ...COMMON,
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-n', '-N', '-T', '-L', `${localSpec(end)}:${remoteSocket}`, '--', checkedHost(host),
  ];
}

export interface SpawnSshOptions {
  /** The `ssh` to run, and arguments before the call's own (tests run a fake). Default: `ssh` on PATH. */
  ssh?: { file: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Starts `ssh` with `argv` as they are: no shell on the desktop reads them again. */
export function spawnSsh(argv: string[], opts: SpawnSshOptions = {}): ChildProcess {
  const ssh = opts.ssh ?? { file: 'ssh', args: [] };
  return spawn(ssh.file, [...ssh.args, ...argv], {
    shell: false,
    windowsHide: true,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
  });
}
