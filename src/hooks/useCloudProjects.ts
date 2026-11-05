'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CloudRemoteAgent } from '@/types/electron';
import { cloudProjectRows, createOnServer, loadCloudProjects, newAgentProjects, type NewAgentForm } from '@/lib/cloud';

/**
 * The connected servers' projects (M3), read again when a link changes, and
 * what every page that opens New agent needs of them: the same project list
 * (`newAgentProjects`) and the same submit for a server's project
 * (`createOnServer`). Nicolas's test of 2026-11-04 found the Agents page
 * without them, the Projects page having the only copy.
 */
export function useCloudProjects(remoteAgents: CloudRemoteAgent[]) {
  const [sets, setSets] = useState<Awaited<ReturnType<typeof loadCloudProjects>>>([]);
  const read = useCallback(() => {
    const cloud = window.electronAPI?.cloud;
    if (cloud) void loadCloudProjects(cloud).then(setSets);
  }, []);
  useEffect(() => {
    read();
    return window.electronAPI?.cloud?.onState(() => read());
  }, [read]);
  const rows = useMemo(() => cloudProjectRows(sets, remoteAgents), [sets, remoteAgents]);
  return {
    rows,
    read,
    newAgentProjects: useCallback((local: Array<{ path: string; name: string }>) => newAgentProjects(local, rows), [rows]),
    createOnServer: useCallback((projectPath: string, form: NewAgentForm) => createOnServer(rows, projectPath, form, window.electronAPI?.cloud ?? null), [rows]),
  };
}
