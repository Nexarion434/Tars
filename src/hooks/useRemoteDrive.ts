'use client';

import { useCallback, useState } from 'react';
import { checkMessage, checkReason } from '@/lib/machines';

type Answer = { success: true } | { success: false; error: string };

/**
 * Start, stop and message one remote agent, where its machine lets this one
 * drive it. The other machine decides at every action: its refusal is a
 * sentence, kept in `error` as it came, until the next action.
 */
export function useRemoteDrive(id: string) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (call: () => Promise<Answer> | undefined): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      const answer = await call();
      if (answer?.success) return true;
      setError(answer?.error ?? 'Machines are not available in this window.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    return false;
  }, []);

  const start = useCallback(() => run(() => window.electronAPI?.machines?.startAgent(id)), [id, run]);
  /** Never sent with a blank reason. */
  const stop = useCallback((reason: string) => {
    const r = checkReason(reason);
    return r ? run(() => window.electronAPI?.machines?.stopAgent(id, r)) : Promise.resolve(false);
  }, [id, run]);
  const message = useCallback((text: string) => {
    const t = checkMessage(text);
    return t ? run(() => window.electronAPI?.machines?.messageAgent(id, t)) : Promise.resolve(false);
  }, [id, run]);

  return { error, busy, start, stop, message, clearError: useCallback(() => setError(null), []) };
}
