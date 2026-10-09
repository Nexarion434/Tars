'use client';

import { useEffect, useState } from 'react';
import type { MachinesView } from '@/types/electron';

/**
 * The machines view (Settings > Machines), read once and read again whenever
 * main says it changed (`machines:changed`), shared by every component that
 * asks, as useClaudeAccounts shares its view.
 */
type Snapshot = { view: MachinesView | null; error: string | null };

let snapshot: Snapshot = { view: null, error: null };
const listeners = new Set<() => void>();
let started = false;

async function read(): Promise<void> {
  try {
    const view = await window.electronAPI?.machines?.view();
    snapshot = { view: view ?? null, error: view ? null : 'Machines are not available in this window.' };
  } catch (err) {
    snapshot = { ...snapshot, error: err instanceof Error ? err.message : String(err) };
  }
  listeners.forEach(l => l());
}

function start(): void {
  if (started) return;
  started = true;
  window.electronAPI?.machines?.onChanged(() => { void read(); });
  void read();
}

export function useMachines(): Snapshot & { reload: () => Promise<void> } {
  const [current, setCurrent] = useState(snapshot);
  useEffect(() => {
    const listener = () => setCurrent(snapshot);
    listeners.add(listener);
    start();
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return { ...current, reload: read };
}
