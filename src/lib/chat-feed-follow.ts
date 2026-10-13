import type { ChatError, ChatEvent, ChatHistory } from '@/types/electron';
import { applyEarlier, applyEvent, applySnapshot, emptyFeed, type ChatFeed } from './chat-feed';

/**
 * How a chat's page reads its conversation and follows it: chat:events are
 * heard from before chat:history is asked, and what is heard while the
 * snapshot is read is applied after it (src/lib/chat-feed.ts holds it). A gap
 * in the seq reads the snapshot again, one read at a time. A snapshot that
 * fails is read again by itself, after waits that grow to a last one, until
 * it answers; a chat that is gone is not. Plain functions, no React: the page
 * mounts one per chat (src/hooks/useChatFeed.ts). Tests:
 * __tests__/lib/chat-feed-follow.test.ts.
 */

/** The lines a page opens on, and each page Show earlier reads. */
export const CHAT_PAGE_LINES = 200;

/** The waits before reading a failed snapshot again, in ms; the last one repeats. */
export const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface ChatFeedSource {
  history: (params: { chatId: string; before?: number; limit?: number }) => Promise<ChatHistory | ChatError>;
  onEvent: (callback: (event: ChatEvent) => void) => () => void;
}

export interface ChatFeedTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface ChatFeedFollower {
  /** Reads the page before the first line held, and resolves once it is in (or dropped). */
  readEarlier: () => Promise<void>;
  stop: () => void;
}

const realTimers: ChatFeedTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const isError = (answer: ChatHistory | ChatError): answer is ChatError =>
  typeof (answer as ChatError).error === 'string';

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function followChatFeed(
  chatId: string,
  source: ChatFeedSource,
  on: { feed: (feed: ChatFeed) => void; problem: (reason: string | null) => void; deleted?: () => void },
  timers: ChatFeedTimers = realTimers,
): ChatFeedFollower {
  let feed = emptyFeed(chatId);
  let alive = true;
  /** What is heard while a snapshot is read; null when none is. */
  let heard: ChatEvent[] | null = null;
  let failures = 0;
  let retry: unknown = null;

  const commit = (next: ChatFeed) => {
    feed = next;
    on.feed(next);
  };

  const read = async (): Promise<void> => {
    if (!alive || heard) return;
    heard = [];
    let answer: ChatHistory | ChatError;
    try {
      answer = await source.history({ chatId, limit: CHAT_PAGE_LINES });
    } catch (error) {
      answer = { error: 'chats_unavailable', reason: reasonOf(error) };
    }
    if (!alive) return;
    const during = heard;
    heard = null;
    if (isError(answer)) {
      on.problem(answer.reason);
      if (answer.error !== 'not_found') {
        retry = timers.set(() => { retry = null; void read(); }, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
        failures += 1;
      }
      return;
    }
    failures = 0;
    commit(applySnapshot(feed, answer, during));
    on.problem(null);
    if (feed.stale) void read();
  };

  const off = source.onEvent(event => {
    if (!alive) return;
    if (heard) {
      heard.push(event);
      return;
    }
    const was = feed;
    const next = applyEvent(was, event);
    if (next === was) return;
    commit(next);
    if (next.stale) void read();
    else if (next.deleted && !was.deleted) on.deleted?.();
  });
  void read();

  return {
    readEarlier: async () => {
      const first = feed.items[0];
      if (!alive || !first) return;
      try {
        const answer = await source.history({ chatId, before: first.n, limit: CHAT_PAGE_LINES });
        if (!alive) return;
        if (isError(answer)) on.problem(answer.reason);
        else commit(applyEarlier(feed, answer, first.n));
      } catch (error) {
        if (alive) on.problem(reasonOf(error));
      }
    },
    stop: () => {
      alive = false;
      off();
      if (retry !== null) timers.clear(retry);
      retry = null;
    },
  };
}
