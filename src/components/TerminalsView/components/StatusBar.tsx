'use client';

import { memo } from 'react';
import type { AgentStatus } from '@/types/electron';
import { machineStatusLabel, type FleetMachine } from '@/lib/machines';

interface StatusBarProps {
  agents: AgentStatus[];
  /** Current git branch of the active project, rendered on the right. */
  branch?: string;
  /** The other machines, when any is paired: `PC ✓`, or `PC offline`. */
  machines?: FleetMachine[];
}

function StatusBar({ agents, branch, machines = [] }: StatusBarProps) {
  const running = agents.filter(a => a.status === 'running').length;

  return (
    <div className="flex items-center gap-4 px-3 py-1 bg-secondary border-t border-border !rounded-none font-mono text-[10px] text-muted-foreground">
      {/* Agent counts */}
      <span>{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
      <span className="text-status-running">{running} running</span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Current branch */}
      {branch && <span>{branch}</span>}

      {/* The other machines, the way a pane's machine is told apart. Frame:
          `Dashboard · two machines`. */}
      {machines.map(m => (
        <span key={m.id} data-machine-status={m.id} className={m.status === 'connected' ? 'text-success' : undefined}>
          {machineStatusLabel(m)}
        </span>
      ))}
    </div>
  );
}

export default memo(StatusBar);
