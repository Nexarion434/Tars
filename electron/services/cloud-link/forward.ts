import * as fs from 'fs';
import type { LocalForwardEnd } from '../../platform/local-forward';
import { classifySshFailure, problemSentence, type SshProblem } from './remote-run';
import { spawnSsh, sshForwardArgv, type SpawnSshOptions } from './ssh';

/**
 * The long `ssh -N -L` from the desktop's end to the server's door socket
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 5).
 *
 * Ready is `ssh -v` saying "Local forwarding listening on" our own end, which
 * it logs only once that bind succeeded; with ExitOnForwardFailure an end it cannot take
 * ends it instead. Ready is not "the door answers": the link asks hello
 * through the forward before anything else. Closing ends this `ssh` and
 * nothing on the server.
 */

export class ForwardError extends Error {
  constructor(readonly problem: SshProblem, message: string, readonly detail = '') {
    super(message);
    this.name = 'ForwardError';
  }
}

export interface Forward {
  end: LocalForwardEnd;
  ready: Promise<void>;
  ended: Promise<{ code: number | null; stderr: string }>;
  close(): void;
}

export interface ForwardOptions {
  ssh?: SpawnSshOptions['ssh'];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

const DEFAULT_READY_MS = 30_000;
const STDERR_KEPT = 16 * 1024;
/**
 * `ssh -v`'s line for our own end, never another forward's: a LocalForward of
 * the user's config can bind and say so while ours fails (security review 1).
 */
const listeningLine = (end: LocalForwardEnd): string =>
  `Local forwarding listening on ${end.kind === 'unix' ? `path ${end.path}` : `127.0.0.1 port ${end.port}`}.`;
const TAKEN = /Could not request local forwarding|cannot listen to|Address already in use/;

function removeOurSocket(end: LocalForwardEnd): void {
  if (end.kind !== 'unix') return;
  try {
    if (fs.lstatSync(end.path).isSocket()) fs.unlinkSync(end.path);
  } catch {
    // Gone already.
  }
}

export function openForward(host: string, end: LocalForwardEnd, remoteSocket: string, opts: ForwardOptions = {}): Forward {
  let argv: string[];
  try {
    argv = ['-v', ...sshForwardArgv(host, end, remoteSocket)];
  } catch (err) {
    const message = (err as Error).message;
    const ready = Promise.reject(new ForwardError('refused', message));
    ready.catch(() => {});
    return { end, ready, ended: Promise.resolve({ code: null, stderr: message }), close: () => {} };
  }

  const child = spawnSsh(argv, { ssh: opts.ssh, env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] });
  const listening = listeningLine(end);
  let stderr = '';
  let isReady = false;
  let closed = false;
  let markReady!: () => void;
  let fail!: (err: ForwardError) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; fail = reject; });
  ready.catch(() => {});
  const failOnce = (err: ForwardError) => {
    if (isReady) return;
    isReady = true;
    clearTimeout(timer);
    fail(err);
  };

  const timer = setTimeout(() => {
    failOnce(new ForwardError('timeout', problemSentence('timeout', host)));
    child.kill('SIGKILL');
  }, opts.readyTimeoutMs ?? DEFAULT_READY_MS);

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT);
    if (!isReady && stderr.includes(listening)) {
      isReady = true;
      clearTimeout(timer);
      markReady();
    }
  });

  const ended = new Promise<{ code: number | null; stderr: string }>(resolve => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      removeOurSocket(end);
      if (TAKEN.test(stderr)) {
        failOnce(new ForwardError('failed', "The forward's end on this computer is taken: another program holds it.", stderr.slice(-200)));
      } else {
        const failure = classifySshFailure(code, stderr);
        failOnce(new ForwardError(failure.problem, problemSentence(failure.problem, host), failure.detail));
      }
      resolve({ code, stderr });
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') failOnce(new ForwardError('ssh-missing', problemSentence('ssh-missing', host)));
      finish(null);
    });
    child.on('exit', code => finish(code));
  });

  return {
    end,
    ready,
    ended,
    close() {
      if (closed) return;
      closed = true;
      failOnce(new ForwardError('failed', 'The forward was closed.'));
      child.kill();
    },
  };
}
