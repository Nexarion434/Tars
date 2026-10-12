'use client';

import type { AgentStatus } from '@/types/electron';

/** The state word of an agent or a chat's runner, as the frames write it beside a name. */
export function StateWord({ status }: { status: AgentStatus['status'] | undefined }) {
  if (status === 'running') return <Word ink="text-status-running" mark="bg-status-running">working</Word>;
  if (status === 'waiting') return <Word ink="text-status-waiting" mark="bg-status-waiting">waiting on you</Word>;
  if (status === 'error') return <Word ink="text-status-error" mark="bg-status-error">error</Word>;
  return <span className="font-mono text-[10.5px] text-status-idle shrink-0">{status ?? 'idle'}</span>;
}

function Word({ ink, mark, children }: { ink: string; mark: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      <span className={`w-1.5 h-1.5 ${mark}`} />
      <span className={`font-mono text-[10.5px] ${ink}`}>{children}</span>
    </span>
  );
}

/** An agent's square: its first letter, and its state in the corner when it works or waits. */
export function AgentSquare({ agent }: { agent: AgentStatus }) {
  const corner = agent.status === 'running' ? 'bg-status-running' : agent.status === 'waiting' ? 'bg-status-waiting' : null;
  return (
    <span className="relative w-6 h-6 shrink-0 flex items-center justify-center bg-secondary border border-border text-[11px] font-semibold text-foreground" title={agent.name ?? agent.id}>
      {(agent.name ?? agent.id).slice(0, 1).toUpperCase()}
      {corner && <span className={`absolute right-[2px] top-[2px] w-1.5 h-1.5 ${corner}`} />}
    </span>
  );
}

/** "10:42" in the person's own time; an empty string for a date that does not parse. */
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}
