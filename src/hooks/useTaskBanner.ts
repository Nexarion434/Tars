'use client';

import { useEffect, useState } from 'react';
import type { AgentStatus, AgentTaskBanner } from '@/types/electron';

/**
 * An agent's task banner (#453's contract): what agent:list carried, then each
 * `agent:task` push for this agent, the latest one winning.
 */
export function useTaskBanner(agent: AgentStatus): AgentTaskBanner | null {
  const [banner, setBanner] = useState<AgentTaskBanner | null>(agent.taskBanner ?? null);
  useEffect(() => {
    setBanner(agent.taskBanner ?? null);
  }, [agent.id, agent.taskBanner]);
  useEffect(() => {
    const off = window.electronAPI?.agent?.onTask?.((event) => {
      if (event.agentId === agent.id) setBanner({ task: event.task, waiting: event.waiting });
    });
    return () => { off?.(); };
  }, [agent.id]);
  return banner;
}
