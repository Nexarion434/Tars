'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { checkReason } from '@/lib/machines';

type Answer = { success: true } | { success: false; error: string };

// The latest sentence a remote agent's machine answered an action or a key
// with, per agent: shared by the pane's keys (useMultiTerminal) and its bar.
// One line, replaced by the next answer and cleared by the next success, so a
// refused burst of keys is one sentence and not one per key.
const errors = new Map<string, string>();
const listeners = new Set<() => void>();

export function reportDriveAnswer(id: string, answer: Answer | undefined, thrown?: unknown): void {
  const next = answer?.success
    ? null
    : answer?.error ?? (thrown ? (thrown instanceof Error ? thrown.message : String(thrown)) : 'Machines are not available in this window.');
  if ((errors.get(id) ?? null) === next) return;
  if (next) errors.set(id, next);
  else errors.delete(id);
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Start and stop one remote agent, where its machine lets this one drive it,
 * and the sentence the machine last refused with. The other machine decides at
 * every action, and its refusal is shown as it came.
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

  const start = useCallback(() => run(() => window.electronAPI?.machines?.startAgent(id)), [id, run]);
  /** Never sent with a blank reason. */
  const stop = useCallback((reason: string) => {
    const r = checkReason(reason);
    return r ? run(() => window.electronAPI?.machines?.stopAgent(id, r)) : Promise.resolve(false);
  }, [id, run]);

  return { error, busy, start, stop };
}
