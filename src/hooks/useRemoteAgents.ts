'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RemoteAgent } from '@/types/electron';
import { fleetMachines, type FleetMachine } from '@/lib/machines';
import { useMachines } from '@/hooks/useMachines';

/**
 * The other machines' agents, read only: asked once, then pushed on every
 * change (`machines.onFleet`). Kept apart from useElectronAgents on purpose:
 * a remote agent is never in the list that starts, stops and deletes agents.
 * Empty where there is no bridge (the browser preview, no machine paired).
 */
export function useRemoteAgents(): RemoteAgent[] {
  const [agents, setAgents] = useState<RemoteAgent[]>([]);

  useEffect(() => {
    const machines = window.electronAPI?.machines;
    if (!machines?.agents) return;
    let live = true;
    machines.agents().then(list => { if (live) setAgents(list); }).catch(() => {});
    const off = machines.onFleet?.(list => { if (live) setAgents(list); });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return agents;
}

/** The other machines, with their status: the paired ones, plus any an agent names. */
export function useFleetMachines(remote: RemoteAgent[]): FleetMachine[] {
  const { view } = useMachines();
  const peers = view?.peers;
  return useMemo(() => fleetMachines(peers ?? [], remote), [peers, remote]);
}
