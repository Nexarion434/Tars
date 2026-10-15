/**
 * Whether a process of this user runs under `pid` (the run record's Tars,
 * services/run-state.ts). Stub: written failures first.
 */
export function processExists(pid: number, kill: typeof process.kill = process.kill): boolean {
  void pid; void kill;
  throw new Error('not yet');
}
