'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CloudRemoteAgent, CloudServerView } from '@/types/electron';
import { fleetMachines, type FleetMachine } from '@/lib/cloud';

/**
 * A Tars server's agents: asked once, then pushed on every change
 * (`cloud.onAgents`). Kept apart from useElectronAgents on purpose: a remote
 * agent is never in the list that starts, stops and deletes this Tars's
 * agents. Empty where there is no main process (the browser preview) or no
 * server linked. Ported from win/machines' hook of the same name.
 */
export function useRemoteAgents(): CloudRemoteAgent[] {
  const [agents, setAgents] = useState<CloudRemoteAgent[]>([]);

  useEffect(() => {
    const cloud = window.electronAPI?.cloud;
    if (!cloud?.agents) return;
    let live = true;
    cloud.agents().then(list => { if (live) setAgents(list); }).catch(() => {});
    const off = cloud.onAgents?.(list => { if (live) setAgents(list); });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return agents;
}

/** The servers, with their status: those linked here, plus any an agent names. */
export function useFleetMachines(remote: CloudRemoteAgent[]): FleetMachine[] {
  const [servers, setServers] = useState<CloudServerView[]>([]);

  useEffect(() => {
    const cloud = window.electronAPI?.cloud;
    if (!cloud?.list) return;
    let live = true;
    const read = () => { cloud.list().then(list => { if (live) setServers(list); }).catch(() => {}); };
    read();
    const off = cloud.onState?.(read);
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return useMemo(() => fleetMachines(servers, remote), [servers, remote]);
}
