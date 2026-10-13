'use client';

import { useSyncExternalStore } from 'react';
import type { ChatError, ChatView, ChatsProblem } from '@/types/electron';

/**
 * The chats' records (chat:list, #361), one listing for the whole window: the
 * sidebar's list, the chats page and a project's page read the same one. It is
 * read when the first of them mounts, after every change one of them makes,
 * and every few seconds while any is mounted, since a chat's runner moves on
 * its own and the chats have no events yet (PR E).
 */

export interface ChatsState {
  /** null until the first listing answers. */
  chats: ChatView[] | null;
  problem: ChatsProblem | null;
  /** When the listing answered, in ms: the moment snoozes and sections are read at, never the clock during a render. */
  at: number;
}

const EVERY_MS = 4000;
let state: ChatsState = { chats: null, problem: null, at: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshChats(): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI?.chat;
  if (!api) {
    if (state.chats === null) {
      state = { chats: [], problem: null, at: Date.now() };
      listeners.forEach(listener => listener());
    }
    return;
  }
  try {
    const listing = await api.list();
    state = { chats: listing.chats, problem: listing.problem, at: Date.now() };
    listeners.forEach(listener => listener());
  } catch (error) {
    console.error('chats: the listing did not answer', error);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshChats();
    timer = setInterval(() => void refreshChats(), EVERY_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => state;
const serverSnapshot: ChatsState = { chats: null, problem: null, at: 0 };

export function useChats(): ChatsState {
  return useSyncExternalStore(subscribe, snapshot, () => serverSnapshot);
}

export function isChatError(value: unknown): value is ChatError {
  return !!value && typeof value === 'object' && typeof (value as ChatError).error === 'string' && typeof (value as ChatError).reason === 'string';
}

/** Runs one of the chat channels, then reads the listing again; answers what the channel answered. */
export async function changeChat<T>(run: (api: NonNullable<Window['electronAPI']>['chat']) => Promise<T>): Promise<T | ChatError> {
  const api = window.electronAPI?.chat;
  if (!api) return { error: 'chats_unavailable', reason: 'The chats are not available in this window.' };
  try {
    const answer = await run(api);
    await refreshChats();
    return answer;
  } catch (error) {
    return { error: 'chats_unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The last part of a project's path, as the list names a project. */
export function projectNameOf(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
}
