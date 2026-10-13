'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyFeed, type ChatFeed } from '@/lib/chat-feed';
import { followChatFeed, type ChatFeedFollower } from '@/lib/chat-feed-follow';
import { refreshChats } from '@/hooks/useChats';

export interface ChatFeedState {
  feed: ChatFeed;
  /** Why the conversation could not be read, as the channel said it; null once it is. */
  problem: string | null;
  /** Reads the lines before the first one held. */
  showEarlier: () => void;
  readingEarlier: boolean;
}

/**
 * A chat's conversation, read and followed by src/lib/chat-feed-follow.ts:
 * the snapshot, the events after it, a re-read after a gap or a failure.
 * Mount it with the chat's id as its key: a page holds one chat.
 */
export function useChatFeed(chatId: string): ChatFeedState {
  const [feed, setFeed] = useState(() => emptyFeed(chatId));
  const [problem, setProblem] = useState<string | null>(null);
  const [readingEarlier, setReadingEarlier] = useState(false);
  const follower = useRef<ChatFeedFollower | null>(null);

  useEffect(() => {
    const api = window.electronAPI?.chat;
    if (!api?.history || !api.onEvent) {
      setProblem('The chats are not available in this window.');
      return;
    }
    // The list moves this page to another chat once it no longer has this one.
    const follow = followChatFeed(chatId, api, { feed: setFeed, problem: setProblem, deleted: () => void refreshChats() });
    follower.current = follow;
    return () => {
      follow.stop();
      follower.current = null;
    };
  }, [chatId]);

  const showEarlier = useCallback(() => {
    const follow = follower.current;
    if (!follow || readingEarlier) return;
    setReadingEarlier(true);
    void follow.readEarlier().finally(() => setReadingEarlier(false));
  }, [readingEarlier]);

  return { feed, problem, showEarlier, readingEarlier };
}
