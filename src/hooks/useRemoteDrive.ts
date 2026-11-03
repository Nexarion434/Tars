'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';

type Answer = { success: true } | { success: false; error: string };

// The latest sentence a server answered an action or a key with, per remote
// agent: shared by the pane's keys (useMultiTerminal) and its bar. One line,
// replaced by the next answer and cleared by the next success, so a refused
// burst of keys is one sentence and not one per key. Ported from win/machines.
const errors = new Map<string, string>();
const listeners = new Set<() => void>();

export function reportDriveAnswer(id: string, answer: Answer | undefined, thrown?: unknown): void {
  const next = answer?.success
    ? null
    : answer?.error ?? (thrown ? (thrown instanceof Error ? thrown.message : String(thrown)) : 'Tars servers are not available in this window.');
  if ((errors.get(id) ?? null) === next) return;
  if (next) errors.set(id, next);
  else errors.delete(id);
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Start and stop one of a server's agents, where it lets this desktop drive,
 * and the sentence the server last refused with. The server decides at every
 * action, and its refusal is shown as it came.
 */
export function useRemoteDrive(id: string) {
  const error = useSyncExternalStore(subscribe, () => errors.get(id) ?? null, () => null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (call: () => Promise<Answer> | undefined): Promise<boolean> => {
    setBusy(true);
    try {
      const answer = await call();
      reportDriveAnswer(id, answer);
      return !!answer?.success;
    } catch (err) {
      reportDriveAnswer(id, undefined, err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [id]);

  const start = useCallback(() => run(() => window.electronAPI?.cloud?.drive(id, 'start', {})), [id, run]);
  /** One click, as a local agent's: main tells the server which computer stopped it (cloud-handlers.ts). */
  const stop = useCallback(() => run(() => window.electronAPI?.cloud?.drive(id, 'stop', {})), [id, run]);

  return { error, busy, start, stop };
}
