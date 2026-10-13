'use client';

import { useLayoutEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUp } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import PermissionAskNotice from '@/components/PermissionAskNotice';
import { RichText } from '@/components/Overseer/RichText';
import { ComposerCard, PanelCaption } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import { useChatFeed } from '@/hooks/useChatFeed';
import type { AgentStatus, ChatItem, ChatView } from '@/types/electron';
import { ChatHead, clockOf } from './chat-bits';

/**
 * A chat's page, its conversation read from its runner's transcripts and
 * followed live (src/hooks/useChatFeed.ts). Frames: `Chat · chats · from its
 * transcripts, working` and `· waiting on you`, in chat-redesign-a.pen. Each
 * line is shown as what it is, the lines of one speaker under one head; the
 * runner in a turn says so at the end of the thread, and its permission ask
 * sits above the composer, the one its window shows. The composer is the
 * Chat's with nobody to receive yet: sending from a chat comes with chat:send
 * (PR D), and so does what the chat delegated, on the right.
 */

/** Within this many pixels of the end, the thread follows what arrives. */
const FOLLOW_PX = 24;

type Speaker = { key: string; name: string; mark: 'you' | 'tars' | 'letter'; runner: boolean };

function speakerOf(item: ChatItem, runnerName: string): Speaker | null {
  switch (item.kind) {
    case 'user': return { key: 'you', name: 'You', mark: 'you', runner: false };
    case 'text':
    case 'tool': return { key: 'runner', name: runnerName, mark: 'letter', runner: true };
    case 'message': return { key: `message:${item.from ?? ''}`, name: item.from ?? 'An agent', mark: 'letter', runner: false };
    case 'note': {
      const from = item.from ?? 'Tars';
      return { key: `note:${from}`, name: from, mark: from === 'Tars' ? 'tars' : 'letter', runner: false };
    }
    default: return null;
  }
}

type Block = { speaker: Speaker; items: ChatItem[] } | { speaker: null; item: ChatItem };

/** The lines of one speaker in a row share a head; a divider or a raw line stands alone. */
function blocksOf(items: ChatItem[], runnerName: string): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    const speaker = speakerOf(item, runnerName);
    const last = blocks[blocks.length - 1];
    if (!speaker) blocks.push({ speaker: null, item });
    else if (last?.speaker && last.speaker.key === speaker.key) last.items.push(item);
    else blocks.push({ speaker, items: [item] });
  }
  return blocks;
}

/** The runner's last tool call in the turn it is in: back over its own lines, to the words it answers. */
function doingOf(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'tool') return items[i].text;
    if (items[i].kind !== 'text') return null;
  }
  return null;
}

function stateOf(runner: { name: string; status: string } | null, ask: AgentStatus['permissionAsk'] | undefined): string {
  if (!runner) return '';
  if (runner.status === 'running') return 'working';
  if (runner.status === 'waiting') return ask ? `waiting on you since ${clockOf(ask.askedAt)}` : 'waiting on you';
  if (runner.status === 'error' || runner.status === 'stopped') return runner.status;
  return `${runner.name} answers here`;
}

/** Where a line of the thread sits under the thread's top, in pixels; null when it is not drawn. */
function topOf(el: HTMLElement, id: string): number | null {
  const line = el.querySelector(`[data-chat-item="${CSS.escape(id)}"]`);
  return line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
}

function Mark({ speaker }: { speaker: Speaker }) {
  if (speaker.mark === 'tars') {
    return <span className="w-6 h-6 shrink-0 flex items-center justify-center"><BrandMark className="w-2.5 h-2.5" /></span>;
  }
  const you = speaker.mark === 'you';
  return (
    <span className={`w-6 h-6 shrink-0 flex items-center justify-center border text-[11px] leading-[1.2] font-semibold text-foreground ${you ? 'bg-accent-dim border-primary' : 'bg-secondary border-border'}`}>
      {speaker.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Line({ item }: { item: ChatItem }) {
  if (item.kind === 'tool') {
    return (
      <div data-chat-item={item.id} data-kind="tool" className="pl-8 flex items-center gap-2 min-w-0">
        <ArrowRight className="w-3 h-3 shrink-0 text-status-idle" />
        <span className="font-mono text-[11px] leading-[1.4] text-text-secondary truncate" title={item.text}>{item.text}</span>
      </div>
    );
  }
  if (item.kind === 'note') {
    const text = item.from === 'Tars' ? item.text.replace(/^\[Tars\]\s*/, '') : item.text;
    return (
      <div data-chat-item={item.id} data-kind="note" className="pl-8">
        <p className="max-w-[700px] text-[13px] leading-[1.5] text-text-secondary whitespace-pre-wrap break-words">{text}</p>
      </div>
    );
  }
  return (
    <div data-chat-item={item.id} data-kind={item.kind} className="pl-8">
      <div className="max-w-[700px] text-[14px] leading-[1.5] text-foreground break-words">
        {item.kind === 'user' ? <p className="whitespace-pre-wrap">{item.text}</p> : <RichText text={item.text} />}
      </div>
    </div>
  );
}

function Alone({ item }: { item: ChatItem }) {
  if (item.kind === 'divider') {
    return (
      <div data-chat-item={item.id} data-kind="divider" className="pl-8 flex items-center gap-2.5">
        <span className="flex-1 h-px bg-border" />
        <span className="font-mono text-[10.5px] leading-[1.4] text-status-idle">{item.text === 'session' ? 'new session' : item.text}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    );
  }
  return (
    <p data-chat-item={item.id} data-kind={item.kind} className="pl-8 font-mono text-[10.5px] leading-[1.4] text-status-idle truncate" title={item.text}>
      {item.text}
    </p>
  );
}

export function ChatPage({ chat }: { chat: ChatView }) {
  const { agents } = useElectronAgents();
  const { feed, problem, showEarlier, readingEarlier } = useChatFeed(chat.id);

  // The record as its last event told it; the runner as the fleet has it now.
  const record = feed.chat ?? chat;
  const runnerId = feed.runner !== undefined ? feed.runner?.id ?? null : record.runnerId;
  const runner = agents.find(agent => agent.id === runnerId);
  const listed = record.runner?.id === runnerId ? record.runner : null;
  const runnerName = runner?.name ?? listed?.name ?? 'The orchestrator';
  const status = runner?.status ?? listed?.status;
  const ask = runner?.status === 'waiting' ? runner.permissionAsk : undefined;
  const working = status === 'running';
  const doing = working ? doingOf(feed.items) : null;
  const team = agents.filter(agent => agent.projectPath === record.projectPath);
  const created = clockOf(record.createdAt);
  const state = stateOf(runnerId && status ? { name: runnerName, status } : null, ask);
  const meta = [created && `created ${created}`, state].filter(Boolean).join(' · ');
  const earlier = feed.hasEarlier ? feed.items[0]?.n ?? 0 : 0;

  // At the end, the thread follows what arrives; scrolled up, it stays. Show
  // earlier keeps the line that was first where it was.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const kept = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const was = kept.current;
    if (was && feed.items[0]?.id !== was.id) {
      kept.current = null;
      const top = topOf(el, was.id);
      if (top !== null) el.scrollTop += top - was.top;
      return;
    }
    if (following.current) el.scrollTop = el.scrollHeight;
  }, [feed.items, working, doing, ask?.askedAt]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
  };
  const readEarlier = () => {
    const el = scroller.current;
    const first = feed.items[0];
    const top = el && first ? topOf(el, first.id) : null;
    kept.current = first && top !== null ? { id: first.id, top } : null;
    showEarlier();
  };

  return (
    <div className="-mx-[26px] -mt-[22px] -mb-[22px] h-screen flex flex-col">
      <ChatHead chat={record} meta={meta} team={team} />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:none]">
            <div className="flex flex-col gap-[18px] pt-6 px-10 pb-4">
              {earlier > 0 && (
                <div className="pl-8 flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={readEarlier}
                    disabled={readingEarlier}
                    className="h-[26px] px-2.5 flex items-center gap-1.5 border border-border bg-card text-[11.5px] text-text-secondary hover:bg-secondary transition-colors disabled:opacity-40"
                  >
                    <ArrowUp className="w-3 h-3" />
                    Show earlier
                  </button>
                  <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle">
                    {earlier} earlier {earlier === 1 ? 'line' : 'lines'}
                  </span>
                </div>
              )}
              {blocksOf(feed.items, runnerName).map(block => block.speaker ? (
                <div key={block.items[0].id} className="flex flex-col gap-1.5">
                  <div data-chat-speaker className="flex items-center gap-2 min-w-0">
                    <Mark speaker={block.speaker} />
                    <span className="text-[12.5px] leading-[1.4] font-semibold text-foreground truncate">{block.speaker.name}</span>
                    {block.speaker.runner && runner?.role === 'orchestrator' && (
                      <span className="h-[22px] px-[7px] flex items-center shrink-0 border border-primary bg-accent-dim font-mono text-[10.5px] leading-[1.35] text-foreground">orchestrator</span>
                    )}
                    <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle shrink-0">{clockOf(block.items[0].at)}</span>
                  </div>
                  {block.items.map(item => <Line key={item.id} item={item} />)}
                </div>
              ) : <Alone key={block.item.id} item={block.item} />)}
              {problem && <p role="alert" className="pl-8 text-xs text-status-waiting">{problem}</p>}
              {working && (
                <div className="pl-8 flex items-center gap-2.5 min-w-0">
                  <span className="w-1.5 h-1.5 shrink-0 bg-status-running" />
                  <span className="text-[12.5px] leading-[1.4] text-text-secondary shrink-0">The orchestrator is working</span>
                  {doing && <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle truncate" title={doing}>{doing}</span>}
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-2 px-10 pb-5">
            {runner && <PermissionAskNotice agent={runner} layout="window" />}
            <ComposerCard
              value=""
              onChange={() => {}}
              onSubmit={() => {}}
              placeholder="Message the orchestrator about this chat"
              canSubmit={false}
              submitLabel="Send"
              disabled
              attachLabel="Attaching comes with sending, in the next part of this preview"
              notice={{
                tone: 'idle',
                hollow: true,
                text: 'Sending from a chat comes with the next part of this preview.',
                actions: (
                  <Link
                    href="/chat"
                    className="inline-flex items-center justify-center h-[26px] px-2.5 border border-border bg-card text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                  >
                    Open Tars, all projects
                  </Link>
                ),
              }}
            />
          </div>
        </div>

        <aside aria-label="Delegated in this chat" className="w-[340px] shrink-0 bg-card border-l border-border flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2.5">
            <PanelCaption>Delegated in this chat</PanelCaption>
          </div>
          <p className="px-4 py-3 text-xs leading-[1.5] text-text-secondary">
            What this chat delegates shows here once each chat has its own runner, with the next part of this preview.
          </p>
          <p className="px-4 py-3 border-t border-border text-[11.5px] leading-[1.45] text-status-idle">
            Each task runs in its agent&apos;s terminal on the Dashboard. The room shows what this project and Tars say to each other.
          </p>
        </aside>
      </div>
    </div>
  );
}
