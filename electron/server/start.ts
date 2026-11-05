import type { ServerStatus } from './lock';

/**
 * `tars-server start`: a server running already is left as it is; an
 * installed systemd user unit starts it when there is one (it restarts it on
 * failure and keeps it across logouts); otherwise a detached `serve`. In a
 * container the container's own start does this, and `serve` is its entry.
 * Never stops anything: a desktop that started a server leaves it running.
 */
export interface StartDeps {
  status(): ServerStatus;
  hasUnit(): boolean;
  startUnit(): void;
  spawnDetached(): void;
  sleep(ms: number): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * What a detached server inherits: the caller's environment without its SSH session (SSH_AUTH_SOCK would hand
 * every agent the desktop's forwarded SSH agent), marked as started by `start`.
 */
export function detachedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('SSH_')));
  return { ...kept, TARS_SERVER_STARTED_BY: 'cli' } as unknown as NodeJS.ProcessEnv;
}

export async function startServer(deps: StartDeps): Promise<ServerStatus> {
  const first = deps.status();
  if (first.running) return first;
  if (deps.hasUnit()) deps.startUnit();
  else deps.spawnDetached();
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.timeoutMs ?? 60_000);
  for (;;) {
    const status = deps.status();
    if (status.running) return status;
    if (now() >= deadline) throw new Error('tars-server did not start: see ~/.tars-private/logs/server.log, or journalctl --user -u tars-server');
    await deps.sleep(250);
  }
}
