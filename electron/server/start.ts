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
    if (now() >= deadline) throw new Error('tars-server did not start: see DATA_DIR/logs/server.log');
    await deps.sleep(250);
  }
}
