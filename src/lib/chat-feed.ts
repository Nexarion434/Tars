import type { ChatEvent, ChatHistory, ChatItem, ChatView } from '@/types/electron';

/**
 * A chat's conversation as its page holds it: the snapshot chat:history
 * answers, then the chat:events after its seq (#371). Every event the window
 * hears goes through here, whichever chat it is about, because the seq is one
 * counter for every chat: another chat's event only moves it, and a number
 * skipped means an event was missed, so nothing more is applied until the
 * snapshot is read again (the seq stays where the gap is, so every later
 * event is past it too). A line is kept by its id, in its place (n): told
 * again, it replaces the one before. Tests: __tests__/lib/chat-feed.test.ts.
 */

export type ChatRunnerState = Extract<ChatEvent, { type: 'state' }>['runner'];

export interface ChatFeed {
  chatId: string;
  items: ChatItem[];
  /** The seq of the snapshot, then of the last event read; -1 until a snapshot is read. */
  seq: number;
  /** A seq was skipped: read the snapshot again. */
  stale: boolean;
  /** The chat's record as its last meta event told it; null until one does. */
  chat: ChatView | null;
  /** Its runner as its last state event told it; undefined until one does. */
  runner: ChatRunnerState | undefined;
  deleted: boolean;
  /** Lines come before the first one held: chat:history with `before` reads them. */
  hasEarlier: boolean;
}

export function emptyFeed(chatId: string): ChatFeed {
  return { chatId, items: [], seq: -1, stale: false, chat: null, runner: undefined, deleted: false, hasEarlier: false };
}

const earlierThanFirst = (items: ChatItem[]) => items.length > 0 && items[0].n > 0;

/** The line in its place by n, or in place of the one with its id. */
function withItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const at = items.findIndex(held => held.id === item.id);
  if (at >= 0) return items.map((held, i) => (i === at ? item : held));
  let place = items.length;
  while (place > 0 && items[place - 1].n > item.n) place -= 1;
  return [...items.slice(0, place), item, ...items.slice(place)];
}

/** One event, in its turn. */
export function applyEvent(feed: ChatFeed, event: ChatEvent): ChatFeed {
  if (feed.seq < 0 || event.seq <= feed.seq) return feed;
  if (event.seq > feed.seq + 1) return { ...feed, stale: true };
  const moved = { ...feed, seq: event.seq };
  if (event.chatId !== feed.chatId) return moved;
  switch (event.type) {
    case 'item': return { ...moved, items: withItem(feed.items, event.item) };
    case 'meta': return { ...moved, chat: event.chat };
    case 'deleted': return { ...moved, deleted: true };
    case 'state': return { ...moved, runner: event.runner };
    default: return moved;
  }
}

/**
 * The snapshot, read first or again after a gap, then what was heard while it
 * was read. Read again, it keeps the earlier pages held when its lines reach
 * them, and only then: lines held up to the one before its first, or past
 * it, leave no hole between the two.
 */
export function applySnapshot(feed: ChatFeed, history: ChatHistory, heard: ChatEvent[] = []): ChatFeed {
  const fresh = [...history.items].sort((a, b) => a.n - b.n);
  const first = fresh[0]?.n;
  const ids = new Set(fresh.map(item => item.id));
  const kept = first !== undefined && feed.items.some(held => held.n >= first - 1)
    ? feed.items.filter(held => held.n < first && !ids.has(held.id))
    : [];
  const items = [...kept, ...fresh];
  let next: ChatFeed = { ...feed, items, seq: history.seq, stale: false, hasEarlier: earlierThanFirst(items) };
  for (const event of heard) next = applyEvent(next, event);
  return next;
}

/**
 * A page from before the first line held, asked from that line (`before`).
 * The seq stays: the page tells nothing new. A page asked from a first line
 * that a re-read has since moved would leave a hole: it is dropped.
 */
export function applyEarlier(feed: ChatFeed, history: ChatHistory, before: number): ChatFeed {
  if (feed.items[0]?.n !== before) return feed;
  let items = feed.items;
  for (const item of history.items) if (!items.some(held => held.id === item.id)) items = withItem(items, item);
  return { ...feed, items, hasEarlier: earlierThanFirst(items) };
}
