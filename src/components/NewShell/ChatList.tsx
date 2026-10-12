'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CalendarClock, Check, ChevronDown, ChevronRight, Ellipsis, FolderKanban, Inbox, Pencil, Pin, Trash2,
} from 'lucide-react';
import { Button, PanelCaption } from '@/components/ui';
import type { ChatError, ChatView, ChatWorkItem } from '@/types/electron';
import { chatSections, chatStateWord, sectionOf, type ChatSectionName } from '@/lib/chat-sections';
import { snoozeLabel, snoozeUntil, type SnoozeChoice } from '@/lib/chat-snooze';
import { changeChat, isChatError, projectNameOf, useChats } from '@/hooks/useChats';

/**
 * The chat list of the new shell, read from the chats' records (#361).
 * Frames: `Shell · chats · list, a chat open` and `Shell · chats · a chat's
 * actions · states`. Each row is its title, its project and number, and its
 * runner's state; its actions sit behind the dots on the row. Delete asks
 * first, and a refusal is shown in the store's own words, the work out named.
 * What a chat says is not here: it comes with PR D and E.
 */

const STATE_WORDS = {
  working: { word: 'working', ink: 'text-status-running', mark: 'bg-status-running' },
  waiting: { word: 'waiting on you', ink: 'text-status-waiting', mark: 'bg-status-waiting' },
  error: { word: 'error', ink: 'text-status-error', mark: 'bg-status-error' },
} as const;

const FOLDED_FIRST: ChatSectionName[] = ['Snoozed', 'Settled'];

const SNOOZES: Array<{ choice: SnoozeChoice; label: string }> = [
  { choice: 'hour', label: 'For an hour' },
  { choice: 'tomorrow', label: 'Until tomorrow, 9:00' },
  { choice: 'monday', label: 'Until Monday, 9:00' },
];

function workLine(item: ChatWorkItem): string {
  const who = item.workerName ?? item.workerId;
  if (item.state === 'queued' && item.queuedAt) {
    const at = new Date(item.queuedAt);
    if (!Number.isNaN(at.getTime())) return `${who}, queued since ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
  }
  return `${who}, ${item.state}`;
}

const menuItemClass = (danger = false) =>
  `w-full flex items-center gap-2 h-7 px-2.5 text-left text-xs transition-colors hover:bg-card ${danger ? 'text-status-error' : 'text-text-secondary'}`;

function ChatMenu({ chat, at, onClose, onRename, onAskDelete, onRefused }: {
  chat: ChatView;
  /** When the listing was read (useChats). */
  at: number;
  onClose: () => void;
  onRename: () => void;
  onAskDelete: () => void;
  onRefused: (error: ChatError) => void;
}) {
  const [snoozing, setSnoozing] = useState(false);
  const run = async (change: Parameters<typeof changeChat>[0]) => {
    onClose();
    const answer = await changeChat(change);
    if (isChatError(answer)) onRefused(answer);
  };
  const snoozed = sectionOf(chat, at) === 'Snoozed';

  if (snoozing) {
    return (
      <div role="menu" aria-label="Snooze until" className="absolute right-0 top-full mt-1 z-30 w-[180px] p-1 bg-secondary border border-border-accent flex flex-col gap-px">
        {SNOOZES.map(({ choice, label }) => (
          <button
            key={choice}
            type="button"
            role="menuitem"
            className={menuItemClass()}
            onClick={() => void run(api => api.snooze({ chatId: chat.id, until: snoozeUntil(choice, new Date()).toISOString() }))}
          >
            <CalendarClock className="w-3 h-3 text-status-idle" />
            {label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div role="menu" aria-label={`Actions for ${chat.title}`} className="absolute right-0 top-full mt-1 z-30 w-[196px] p-1 bg-secondary border border-border-accent flex flex-col gap-px">
      <button type="button" role="menuitem" className={menuItemClass()} onClick={() => void run(api => api.pin({ chatId: chat.id, pinned: !chat.pinned }))}>
        <Pin className="w-3 h-3 text-status-idle" />
        {chat.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button type="button" role="menuitem" className={menuItemClass()} onClick={() => { onClose(); onRename(); }}>
        <Pencil className="w-3 h-3 text-status-idle" />
        Rename
      </button>
      {snoozed ? (
        <button type="button" role="menuitem" className={menuItemClass()} onClick={() => void run(api => api.snooze({ chatId: chat.id, until: null }))}>
          <CalendarClock className="w-3 h-3 text-status-idle" />
          Unsnooze
        </button>
      ) : (
        <button type="button" role="menuitem" className={menuItemClass()} onClick={() => setSnoozing(true)}>
          <CalendarClock className="w-3 h-3 text-status-idle" />
          <span className="flex-1">Snooze</span>
          <ChevronRight className="w-3 h-3 text-status-idle" />
        </button>
      )}
      <button type="button" role="menuitem" className={menuItemClass()} onClick={() => void run(api => api.settle({ chatId: chat.id, settled: !chat.settledAt }))}>
        <Check className="w-3 h-3 text-status-idle" />
        {chat.settledAt ? 'Unsettle' : 'Settle'}
      </button>
      {!chat.inbox && (
        <button type="button" role="menuitem" className={menuItemClass()} onClick={() => void run(api => api.setInbox({ chatId: chat.id }))}>
          <Inbox className="w-3 h-3 text-status-idle" />
          Make it the inbox
        </button>
      )}
      <div aria-hidden className="px-2.5 py-1">
        <div className="h-px bg-border" />
      </div>
      <button type="button" role="menuitem" className={menuItemClass(true)} onClick={() => { onClose(); onAskDelete(); }}>
        <Trash2 className="w-3 h-3" />
        Delete
      </button>
    </div>
  );
}

function ChatRow({ chat, current, at }: { chat: ChatView; current: boolean; at: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState<ChatError | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const state = chatStateWord(chat);
  const words = state ? STATE_WORDS[state] : null;
  const snooze = snoozeLabel(chat.snoozedUntil, new Date(at));
  const name = projectNameOf(chat.projectPath);

  // A click elsewhere, or Escape, puts the menu away.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!area.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const keepTitle = async () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === chat.title) return;
    const answer = await changeChat(api => api.rename({ chatId: chat.id, title }));
    if (isChatError(answer)) setRefused(answer);
  };

  const remove = async () => {
    setAsking(false);
    const answer = await changeChat(api => api.delete({ chatId: chat.id }));
    if (isChatError(answer)) setRefused(answer);
  };

  return (
    <div ref={area} data-chat-row className="group relative">
      {renaming ? (
        <div className="px-2.5 py-[5px] border border-border-accent bg-secondary">
          <input
            autoFocus
            aria-label={`Title of ${chat.title}`}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void keepTitle();
              if (event.key === 'Escape') {
                setDraft(chat.title);
                setRenaming(false);
              }
            }}
            onBlur={() => {
              setDraft(chat.title);
              setRenaming(false);
            }}
            className="w-full h-[26px] px-2 bg-card border border-primary text-[12.5px] text-foreground outline-none"
          />
          <p className="mt-0.5 font-mono text-[10.5px] text-status-idle">{name} #{chat.number}</p>
        </div>
      ) : (
        <Link
          href={`/chats?chat=${encodeURIComponent(chat.id)}`}
          aria-current={current ? 'page' : undefined}
          className={`block px-2.5 py-[5px] border transition-colors ${current ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary'}`}
        >
          <span className="block pr-6 text-[12.5px] leading-[1.4] truncate text-foreground">{chat.title}</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-[10.5px] text-status-idle truncate">{name}</span>
            <span className="font-mono text-[10.5px] text-status-idle shrink-0">#{chat.number}</span>
            <span className="flex-1" />
            {words && (
              <span className="flex items-center gap-1.5 shrink-0">
                <span className={`w-1.5 h-1.5 ${words.mark}`} />
                <span className={`font-mono text-[10.5px] ${words.ink}`}>{words.word}</span>
              </span>
            )}
            {snooze && <span className="font-mono text-[10.5px] text-status-idle shrink-0">{snooze}</span>}
          </span>
        </Link>
      )}

      {!renaming && (
        <button
          type="button"
          aria-label={`Actions for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setRefused(null);
            setMenuOpen(open => !open);
          }}
          className={`absolute right-2 top-[5px] w-[22px] h-[22px] flex items-center justify-center border border-border bg-card text-text-secondary transition-opacity ${
            menuOpen || current ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <Ellipsis className="w-3 h-3" />
        </button>
      )}

      {menuOpen && (
        <ChatMenu
          chat={chat}
          at={at}
          onClose={() => setMenuOpen(false)}
          onRename={() => {
            setDraft(chat.title);
            setRenaming(true);
          }}
          onAskDelete={() => setAsking(true)}
          onRefused={setRefused}
        />
      )}

      {asking && (
        <div role="alertdialog" aria-label={`Delete ${name} #${chat.number}, ${chat.title}?`} className="mt-1 px-2.5 py-2 bg-secondary border border-border flex flex-col gap-2">
          <p className="flex gap-2 text-[11.5px] leading-[1.45] text-foreground">
            <span className="mt-[5px] w-1.5 h-1.5 shrink-0 bg-status-idle" />
            <span>Delete {name} #{chat.number}, {chat.title}? Its record goes and its number is not used again; its transcripts stay on disk.</span>
          </p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" onClick={() => setAsking(false)}>cancel</Button>
            <Button size="sm" onClick={() => void remove()}>delete</Button>
          </div>
        </div>
      )}

      {refused && (
        <div role="alert" className="mt-1 px-2.5 py-2 bg-secondary border border-border flex flex-col gap-1.5">
          <p className="flex gap-2 text-[11.5px] leading-[1.45] text-foreground">
            <span className="mt-[5px] w-1.5 h-1.5 shrink-0 bg-status-waiting" />
            <span>{refused.reason}</span>
          </p>
          {refused.tasks?.map(item => (
            <p key={`${item.workerId}-${item.ref ?? 'link'}`} className="font-mono text-[10.5px] text-text-secondary">{workLine(item)}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHead({ name, count, folded, onToggle }: { name: string; count: number; folded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={!folded}
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 pl-2.5 pr-2.5 pt-2 pb-[3px] text-left"
    >
      <PanelCaption>{name}</PanelCaption>
      <span className="font-mono text-[10px] text-status-idle">{count}</span>
      <span className="flex-1" />
      {folded ? <ChevronRight className="w-3 h-3 text-status-idle" /> : <ChevronDown className="w-3 h-3 text-status-idle" />}
    </button>
  );
}

export function ChatList({ filter, onFilter, selectedId }: {
  filter: string | null;
  onFilter: (projectPath: string | null) => void;
  selectedId: string | null;
}) {
  const { chats, at } = useChats();
  const [folded, setFolded] = useState<Set<ChatSectionName>>(() => new Set(FOLDED_FIRST));
  const [filterOpen, setFilterOpen] = useState(false);
  const filterArea = useRef<HTMLDivElement>(null);

  const projects = useMemo(() => {
    const paths = Array.from(new Set((chats ?? []).map(chat => chat.projectPath)));
    return paths.sort((a, b) => projectNameOf(a).localeCompare(projectNameOf(b)));
  }, [chats]);
  const sections = useMemo(() => chatSections(chats ?? [], { now: at, project: filter }), [chats, at, filter]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!filterArea.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [filterOpen]);

  const toggle = (name: ChatSectionName) => setFolded(previous => {
    const next = new Set(previous);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  const none = chats !== null && chats.length === 0;

  return (
    <>
      <div className="flex items-center justify-between gap-2 pl-[18px] pr-2 pt-3 pb-0.5 shrink-0">
        <PanelCaption>Chats</PanelCaption>
        <div ref={filterArea} className="relative">
          <button
            type="button"
            aria-label="Project filter"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            disabled={none}
            onClick={() => setFilterOpen(open => !open)}
            className={`h-[26px] px-2 flex items-center gap-1.5 border text-[11.5px] disabled:opacity-40 disabled:cursor-not-allowed ${
              filter ? 'border-border-accent bg-secondary text-foreground' : 'border-border bg-card text-text-secondary'
            }`}
          >
            <FolderKanban className="w-3 h-3 text-status-idle" />
            <span className="max-w-[96px] truncate">{filter ? projectNameOf(filter) : 'All projects'}</span>
            <ChevronDown className="w-3 h-3 text-status-idle" />
          </button>
          {filterOpen && (
            <div role="menu" aria-label="Project filter" className="absolute right-0 top-full mt-1 z-30 min-w-[160px] p-1 bg-secondary border border-border-accent flex flex-col gap-px">
              {[null, ...projects].map(projectPath => (
                <button
                  key={projectPath ?? 'all'}
                  type="button"
                  role="menuitem"
                  className={menuItemClass()}
                  onClick={() => {
                    setFilterOpen(false);
                    onFilter(projectPath);
                  }}
                >
                  <span className={`w-1 h-1 shrink-0 ${projectPath === filter ? 'bg-primary' : ''}`} />
                  {projectPath ? projectNameOf(projectPath) : 'All projects'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {none ? (
        <div className="px-[18px] pt-2.5 shrink-0">
          <p className="text-[12.5px] leading-[1.4] text-text-secondary">No chats yet</p>
          <p className="mt-1 text-[11px] leading-[1.45] text-status-idle">
            A project gets its chat Main once it has an orchestrator. Talk to Tars, all projects meanwhile.
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {chats !== null && sections.length === 0 && filter && (
            <p className="px-2.5 pt-2.5 text-[11px] text-status-idle">No chats in {projectNameOf(filter)}.</p>
          )}
          {sections.map(section => {
            const isFolded = folded.has(section.name);
            return (
              <section key={section.name} aria-label={section.name}>
                <SectionHead name={section.name} count={section.chats.length} folded={isFolded} onToggle={() => toggle(section.name)} />
                {!isFolded && (
                  <div className="flex flex-col gap-px">
                    {section.chats.map(chat => <ChatRow key={chat.id} chat={chat} current={chat.id === selectedId} at={at} />)}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
