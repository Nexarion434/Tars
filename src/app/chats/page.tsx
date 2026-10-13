'use client';

import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import { PageHeader } from '@/components/ui';

/**
 * The chats page of the new shell, in the state `Shell · chats · empty` draws
 * until the chat channels exist: a conversation with a project's orchestrator
 * cannot be opened yet, so the page says so and points at Tars, all projects,
 * where every orchestrator can be talked to today. No chat is made up.
 */
export default function ChatsPage() {
  return (
    <div className="h-[calc(100vh-44px)] flex flex-col">
      <PageHeader title="Chats" subtitle="A conversation with the orchestrator of a project, on one topic." />
      <div className="flex-1 min-h-0 border border-border bg-card flex flex-col items-center justify-center gap-3 pb-[60px]">
        <BrandMark className="w-2.5 h-2.5" />
        <h2 className="font-serif text-[22px] leading-[1.15] text-foreground">No chats yet</h2>
        <p className="max-w-[460px] text-center text-[12.5px] leading-[1.5] text-text-secondary">
          Chats per project come with the next part of this preview. Until then, Tars, all projects is where you talk
          to every orchestrator.
        </p>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 h-8 px-3 border border-border bg-card text-sm text-foreground hover:bg-secondary transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5 text-status-idle" />
          Open Tars, all projects
        </Link>
      </div>
    </div>
  );
}
