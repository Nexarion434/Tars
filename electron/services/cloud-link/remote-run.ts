import type { ChildProcess } from 'child_process';
import { spawnSsh, sshCommandArgv, type ServerCommand, type ServerRunner, type SpawnSshOptions } from './ssh';

/**
 * One server command over SSH (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 2).
 *
 * The server's CLI writes one JSON line on stdout when it succeeds and says
 * what went wrong on stderr. The SSH user's shell may print a banner first, so
 * only the last line of stdout is read, and it must be a JSON object. `ssh`
 * exits 255 for its own errors, which are read from its stderr into a problem
 * the user can act on.
 */

export type SshProblem =
  | 'ssh-missing'
  | 'host-key-unknown'
  | 'host-key-changed'
  | 'key-refused'
  | 'unreachable'
  | 'timeout'
  | 'sudo-password'
  | 'not-installed'
  | 'container-stopped'
  | 'unreadable'
  | 'refused'
  | 'failed';

export type RunResult =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; problem: SshProblem; detail: string };

export interface RunOptions {
  /** JSON input, written on stdin (never on the command line). Without it, stdin is closed at once. */
  stdin?: object;
  timeoutMs?: number;
  ssh?: SpawnSshOptions['ssh'];
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE = 64 * 1024;
const MAX_STDOUT = 256 * 1024;
const MAX_STDERR = 16 * 1024;
const DETAIL = 200;

/** `ssh`'s own errors (exit 255). The first match wins. */
const SSH_PROBLEMS: Array<[RegExp, SshProblem]> = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/, 'host-key-changed'],
  [/Host key verification failed|host key is known for/, 'host-key-unknown'],
  [/Permission denied \(/, 'key-refused'],
  [/Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable|Connection closed by|Connection reset by/, 'unreachable'],
];

/** What `sudo`, `docker` and the remote shell say when the server cannot be run. */
const SERVER_PROBLEMS: Array<[RegExp, SshProblem]> = [
  [/sudo: (?:a password is required|a terminal is required)/, 'sudo-password'],
  [/No such container|command not found|Cannot find module/, 'not-installed'],
  [/is not running/, 'container-stopped'],
];

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function readAnswer(stdout: string): RunResult {
  const line = lastLine(stdout);
  const unreadable: RunResult = { ok: false, problem: 'unreadable', detail: line.slice(0, DETAIL) };
  if (!line || line.length > MAX_LINE) return unreadable;
  try {
    const json: unknown = JSON.parse(line);
    if (json && typeof json === 'object' && !Array.isArray(json)) return { ok: true, json: json as Record<string, unknown> };
  } catch {
    // Not JSON: unreadable, below.
  }
  return unreadable;
}

function classify(code: number | null, stderr: string): RunResult {
  const detail = lastLine(stderr).slice(0, DETAIL);
  const table = code === 255 ? [...SSH_PROBLEMS, ...SERVER_PROBLEMS] : SERVER_PROBLEMS;
  const found = table.find(([pattern]) => pattern.test(stderr));
  if (found) return { ok: false, problem: found[1], detail };
  if (code === 127) return { ok: false, problem: 'not-installed', detail };
  return { ok: false, problem: 'failed', detail };
}

/** Runs `command` on the server `profile` names, and reads its one JSON answer. */
export function runServerCommand(
  profile: { host: string; runner: ServerRunner },
  command: ServerCommand,
  opts: RunOptions = {},
): Promise<RunResult> {
  let argv: string[];
  try {
    argv = sshCommandArgv(profile.host, profile.runner, command);
  } catch (err) {
    return Promise.resolve({ ok: false, problem: 'refused', detail: (err as Error).message.slice(0, DETAIL) });
  }

  return new Promise(resolve => {
    let child: ChildProcess;
    let settled = false;
    let cut: RunResult | null = null;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';

    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A command cut short is settled when its process is gone, not when its pipes close.
    const stop = (result: RunResult) => {
      if (cut) return;
      cut = result;
      child.kill('SIGKILL');
    };

    child = spawnSsh(argv, { ssh: opts.ssh, env: opts.env });
    const timer = setTimeout(() => stop({ ok: false, problem: 'timeout', detail: '' }), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'ENOENT'
        ? { ok: false, problem: 'ssh-missing', detail: '' }
        : { ok: false, problem: 'failed', detail: error.message.slice(0, DETAIL) });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT) {
        stop({ ok: false, problem: 'unreadable', detail: Buffer.concat(out).toString('utf8').slice(0, DETAIL) });
        return;
      }
      out.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (err.length < MAX_STDERR) err += chunk.slice(0, MAX_STDERR - err.length);
    });
    child.on('exit', () => {
      if (cut) settle(cut);
    });
    child.on('close', (code: number | null) => {
      if (cut) return settle(cut);
      settle(code === 0 ? readAnswer(Buffer.concat(out).toString('utf8')) : classify(code, err));
    });

    child.stdin?.on('error', () => { /* the remote end went away first: its exit says why */ });
    child.stdin?.end(opts.stdin === undefined ? undefined : `${JSON.stringify(opts.stdin)}\n`);
  });
}

/** What `problem` means for the user, and what they can do about it. */
export function problemSentence(problem: SshProblem, host: string): string {
  switch (problem) {
    case 'ssh-missing': return 'Tars could not find ssh on this computer. Install the OpenSSH client, then connect again.';
    case 'host-key-unknown': return `This computer has never connected to ${host}. Run ssh ${host} once in a terminal, check the key it shows and accept it, then connect again.`;
    case 'host-key-changed': return `${host} shows another host key than the one this computer knows. If the server was not reinstalled, do not connect. If it was, run ssh ${host} in a terminal and follow what it says.`;
    case 'key-refused': return `${host} refused this computer's SSH key. Add the key to the server's authorized_keys, or load it in your SSH agent.`;
    case 'unreachable': return `Tars could not reach ${host}. Check the address and this computer's network.`;
    case 'timeout': return `${host} did not answer in time.`;
    case 'sudo-password': return `sudo on ${host} asks for a password, which Tars cannot type. Let this user run docker without one, or turn sudo off for this server.`;
    case 'not-installed': return `The Tars server is not where this server's settings say on ${host}: check the command or the container name.`;
    case 'container-stopped': return `The server's container on ${host} is stopped.`;
    case 'unreadable': return 'The server answered something Tars cannot read.';
    case 'refused': return 'These server settings cannot be used. Fix them in Settings, Cloud.';
    case 'failed': return `The command on ${host} failed.`;
  }
}
