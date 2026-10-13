'use client';

import { useSyncExternalStore } from 'react';
import { changeChat, isChatError, refreshChats } from '@/hooks/useChats';
import { clearsField, outcomeOf, titleOf, type SendOutcome } from '@/lib/chat-send';

/**
 * A chat's composer, kept per chat for the whole window: its words, the send
 * on its way and what that send came to (the Audit's L1 on PR 392). A chat's
 * page is keyed by its chat, so opening another chat unmounts its field, and
 * a launch can take a minute (git fetch, the worktree, its dependencies). What
 * chat:send answers is written here whether a page of the chat is open or not,
 * so opening the chat again shows it, the words back in the field, and a send
 * still on its way is not sent twice. A reload starts from nothing, as
 * useChats does. Tests: __tests__/hooks/chat-composer-store.test.ts.
 */

export interface ChatComposer {
  /** The field's words. */
  text: string;
  /** A send on its way, from the click until chat:send answers. */
  sending: boolean;
  /** What the last send came to; null before one, and while one is on its way. */
  outcome: SendOutcome | null;
  /** Its first message's name, refused by chat:rename. */
  nameProblem: string | null;
}

const EMPTY: ChatComposer = { text: '', sending: false, outcome: null, nameProblem: null };
const composers = new Map<string, ChatComposer>();
const listeners = new Set<() => void>();

export function composerOf(chatId: string): ChatComposer {
  return composers.get(chatId) ?? EMPTY;
}

function change(chatId: string, part: Partial<ChatComposer>): void {
  composers.set(chatId, { ...composerOf(chatId), ...part });
  listeners.forEach(listener => listener());
}

export function subscribeComposers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The field's words, as they are written. */
export function writeComposer(chatId: string, text: string): void {
  change(chatId, { text });
}

/** A held message goes in once the orchestrator takes a turn: its strip has said what it had to. A refusal stays. */
export function forgetSentOutcome(chatId: string): void {
  if (composerOf(chatId).outcome?.kind === 'sent') change(chatId, { outcome: null });
}

/**
 * The chat's words through chat:send, one send at a time per chat. They leave
 * the field once they went in, unless others were written since; a first
 * message names a chat nobody named (`nameIt`), its page open or not.
 */
export async function sendComposer(chatId: string, options: { nameIt: boolean }): Promise<void> {
  const { text: words, sending } = composerOf(chatId);
  if (!words.trim() || sending) return;
  change(chatId, { sending: true, outcome: null, nameProblem: null });
  let read: SendOutcome;
  try {
    const api = window.electronAPI?.chat;
    read = outcomeOf(api
      ? await api.send({ chatId, text: words, clientRequestId: crypto.randomUUID(), mode: 'auto' })
      : new Error('The chats are not available in this window.'));
  } catch (error) {
    read = outcomeOf(error instanceof Error ? error : new Error(String(error)));
  }
  const now = composerOf(chatId).text;
  change(chatId, { sending: false, outcome: read, text: clearsField(read) && now === words ? '' : now });
  const title = clearsField(read) && options.nameIt ? titleOf(words) : null;
  if (title) {
    const named = await changeChat(api => api.rename({ chatId, title }));
    if (isChatError(named)) change(chatId, { nameProblem: `This chat keeps its name: ${named.reason}` });
  }
  void refreshChats();
}

/** One chat's composer, for its page. */
export function useChatComposer(chatId: string): ChatComposer {
  return useSyncExternalStore(subscribeComposers, () => composerOf(chatId), () => EMPTY);
}
