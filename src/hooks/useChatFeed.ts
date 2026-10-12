'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatEvent } from '@/types/electron';
import { applyEarlier, applyEvent, applySnapshot, emptyFeed, type ChatFeed } from '@/lib/chat-feed';
import { isChatError, refreshChats } from '@/hooks/useChats';

/** The lines a page opens on, and each page Show earlier reads. */
export const CHAT_PAGE_LINES = 200;

export interface ChatFeedState {
  feed: ChatFeed;
  /** The snapshot has answered. */
  loaded: boolean;
  /** Why the conversation could not be read, as the channel said it. */
  problem: string | null;
  /** Reads the lines before the first one held. */
  showEarlier: () => void;
  readingEarlier: boolean;
}

/**
 * A chat's conversation, held as src/lib/chat-feed.ts says: chat:events are
 * heard from before the snapshot is asked for, and what is heard while it is
 * read is applied after it, so nothing falls between the two. A gap in the
 * seq reads the snapshot again. Mount it with the chat's id as its key: a
 * page holds one chat.
 */
export function useChatFeed(chatId: string): ChatFeedState {
  const [feed, setFeed] = useState(() => emptyFeed(chatId));
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const held = useRef(feed);
  const commit = useCallback((next: ChatFeed) => {
    held.current = next;
    setFeed(next);
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.chat;
    let alive = true;
    if (!api?.history || !api.onEvent) {
      setProblem('The chats are not available in this window.');
      return;
    }
    /** What is heard while a snapshot is read; null when none is. */
    let heard: ChatEvent[] | null = null;

    const read = async () => {
      if (heard) return;
      heard = [];
      try {
        const answer = await api.history({ chatId, limit: CHAT_PAGE_LINES });
        if (!alive) return;
        const during = heard;
        heard = null;
        if (isChatError(answer)) {
          setProblem(answer.reason);
          return;
        }
        commit(applySnapshot(held.current, answer, during));
        setProblem(null);
        setLoaded(true);
        if (held.current.stale) void read();
      } catch (error) {
        heard = null;
        if (alive) setProblem(error instanceof Error ? error.message : String(error));
      }
    };

    const off = api.onEvent(event => {
      if (!alive) return;
      if (heard) {
        heard.push(event);
        return;
      }
      const was = held.current;
      const next = applyEvent(was, event);
      if (next === was) return;
      commit(next);
      if (next.stale) void read();
      // The list moves this page to another chat once it no longer has this one.
      else if (next.deleted && !was.deleted) void refreshChats();
    });
    void read();
    return () => {
      alive = false;
      off();
    };
  }, [chatId, commit]);

  const showEarlier = useCallback(() => {
    const api = window.electronAPI?.chat;
    const first = held.current.items[0];
    if (!api?.history || !first || readingEarlier) return;
    setReadingEarlier(true);
    api.history({ chatId, before: first.n, limit: CHAT_PAGE_LINES })
      .then(answer => {
        if (isChatError(answer)) setProblem(answer.reason);
        else commit(applyEarlier(held.current, answer));
      })
      .catch(error => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => setReadingEarlier(false));
  }, [chatId, commit, readingEarlier]);

  return { feed, loaded, problem, showEarlier, readingEarlier };
}
