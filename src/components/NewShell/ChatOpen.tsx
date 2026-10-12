'use client';

import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import { PanelCaption } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import type { ChatView } from '@/types/electron';
import { ChatHead, clockOf } from './chat-bits';

/**
 * A chat opened from the list, while its conversation cannot be read yet
 * (`Shell · chats · list, a chat open`): its head as the chat page draws it,
 * and where the conversation goes, the sentence that it opens with the next
 * part of the preview (PR D and E), with a way to Tars, all projects. Nothing
 * is shown of what it said or delegated: there is nothing to read yet.
 */
export function ChatOpen({ chat }: { chat: ChatView }) {
  const { agents } = useElectronAgents();
  const team = agents.filter(agent => agent.projectPath === chat.projectPath);
  const created = clockOf(chat.createdAt);
  const meta = `${created ? `created ${created}` : ''}${chat.runner ? `${created ? ' · ' : ''}${chat.runner.name} answers here` : ''}`;

  return (
    <div className="-mx-[26px] -mt-[22px] -mb-[22px] h-screen flex flex-col">
      <ChatHead chat={chat} meta={meta} team={team} />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 px-10 pb-20">
          <BrandMark className="w-2.5 h-2.5" />
          <h2 className="font-serif text-[22px] leading-[1.15] text-foreground text-center">
            Its conversation opens with the next part of this preview
          </h2>
          <p className="max-w-[480px] text-center text-[12.5px] leading-[1.5] text-text-secondary">
            The chat is kept: its number, its title and its place in the list. Until its orchestrator can answer
            here, Tars, all projects talks to every orchestrator.
          </p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 h-8 px-3 border border-border bg-card text-sm text-foreground hover:bg-secondary transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5 text-status-idle" />
            Open Tars, all projects
          </Link>
        </div>
        <aside aria-label="Delegated in this chat" className="w-[340px] shrink-0 bg-card border-l border-border flex flex-col">
          <div className="flex items-center justify-between px-4 pt-4 pb-2.5">
            <PanelCaption>Delegated in this chat</PanelCaption>
            <span className="font-mono text-[10px] text-status-idle">0</span>
          </div>
          <p className="px-4 py-3 border-t border-border text-xs text-status-idle">Nothing delegated from this chat yet.</p>
        </aside>
      </div>
    </div>
  );
}
