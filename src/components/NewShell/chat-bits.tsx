'use client';

import Link from 'next/link';
import { FolderKanban, Users } from 'lucide-react';
import { PanelCaption } from '@/components/ui';
import { projectNameOf } from '@/hooks/useChats';
import type { AgentStatus, Chat } from '@/types/electron';

/**
 * An open chat's head (`Shell · chats · list, a chat open`, and the chat page's
 * frames): its title, its project and number, a line under them, its team and
 * the room.
 */
export function ChatHead({ chat, meta, team }: { chat: Chat; meta: string; team: AgentStatus[] }) {
  return (
    <div className="flex items-center justify-between gap-4 pl-[26px] pr-5 pt-4 pb-3.5 border-b border-border shrink-0">
      <div className="min-w-0 flex flex-col gap-[7px]">
        <h1 className="font-serif text-[22px] leading-[1.15] text-foreground truncate">{chat.title}</h1>
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-[22px] px-[7px] flex items-center gap-[5px] border border-border bg-card shrink-0">
            <FolderKanban className="w-[11px] h-[11px] text-status-idle" />
            <span className="font-mono text-[10.5px] text-text-secondary">{projectNameOf(chat.projectPath)} #{chat.number}</span>
          </span>
          <span className="font-mono text-[11px] text-status-idle truncate">{meta}</span>
        </div>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        <PanelCaption>Team</PanelCaption>
        <span className="flex items-center gap-1.5">
          {team.map(agent => <AgentSquare key={agent.id} agent={agent} />)}
        </span>
        <Link
          href="/chat"
          className="h-[26px] px-2.5 flex items-center gap-1.5 border border-border bg-card text-xs text-text-secondary hover:bg-secondary transition-colors"
        >
          <Users className="w-3 h-3" />
          Room
        </Link>
      </div>
    </div>
  );
}

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
