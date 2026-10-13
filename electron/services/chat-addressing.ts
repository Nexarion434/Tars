import * as fs from 'fs';
import { writeSecretFileSync } from '../utils/secret-file';
import { projectWord } from './orchestrator-routing';
import { titleOf, type Chat } from './chats';

/**
 * How a message from Telegram, Slack or Discord names one of a project's chats,
 * and how Tars's own Telegram bot remembers which chat each message it sent
 * came from (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0).
 *
 * No routing by content: a reply goes to the chat it answers, "#N" at the very
 * start names chat N of the project, and anything else goes to the project's
 * inbox. An "#N" the project has no chat for reaches nobody, and is answered
 * with the numbered list.
 */

/** "#N text": a number of at most 6 digits, no leading zero, glued to the #, then text. */
const ADDRESS = /^#([1-9]\d{0,5})(?:[:,]\s*|\s+)(\S[\s\S]*)$/;

export function parseChatAddress(message: string): { number: number; text: string } | null {
  const found = ADDRESS.exec(message.trim());
  return found ? { number: Number(found[1]), text: found[2].trim() } : null;
}

/** What every outgoing message of a chat starts with: "[<project> #N <title>]". */
export function chatTag(chat: Pick<Chat, 'projectPath' | 'number' | 'title'>): string {
  return `[${projectWord(chat.projectPath)} #${chat.number} ${titleOf(chat.title) ?? ''}]`;
}

/** One spelling of a project's path: a trailing slash is the same folder. */
const sameProject = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

const ofProject = (chats: Chat[], projectPath: string) =>
  chats.filter((c) => sameProject(c.projectPath, projectPath)).sort((a, b) => a.number - b.number);

/** The project's chats, numbered, and how to name one. */
export function chatListFor(projectPath: string, chats: Chat[]): string {
  const lines = ofProject(chats, projectPath).map((c) => `#${c.number} ${titleOf(c.title) ?? ''}`);
  return `Chats of ${projectWord(projectPath)}:\n${lines.join('\n')}\nStart a message with "#N " to write to chat N; without it, it goes to the inbox.`;
}

export type ChatPick =
  | { kind: 'chat'; chat: Chat }
  /** No chat of the project has that number: nobody is reached, and the sender gets the list. */
  | { kind: 'unknown'; list: string }
  /** The project has no chats (no orchestrator yet, or the chats are not loaded): the caller keeps to its orchestrator. */
  | { kind: 'none' };

/** The chat a message is for: chat `number` of the project, or its inbox when it names none. */
export function pickChat(chats: Chat[], projectPath: string, number: number | null): ChatPick {
  const own = ofProject(chats, projectPath);
  if (own.length === 0) return { kind: 'none' };
  if (number === null) {
    const inbox = own.find((c) => c.inbox) ?? own.find((c) => c.number === 1);
    return inbox ? { kind: 'chat', chat: inbox } : { kind: 'none' };
  }
  const named = own.find((c) => c.number === number);
  return named ? { kind: 'chat', chat: named } : { kind: 'unknown', list: chatListFor(projectPath, chats) };
}

/** How long a reply to a message Tars's bot sent still reaches its chat. */
export const CHAT_SENT_KEPT_MS = 7 * 24 * 3_600_000;
/** The most entries the log holds: the newest are kept. */
export const CHAT_SENT_MAX = 2_000;

interface SentEntry { telegramChatId: string; messageId: number; chatId: string; at: number }

export interface ChatSentLog {
  record(entry: { telegramChatId: string; messageId: number; chatId: string }, now?: number): void;
  /** The chat a message of that Telegram chat was sent for, within the 7 days. */
  chatOf(telegramChatId: string, messageId: number, now?: number): string | undefined;
}

const isEntry = (e: unknown): e is SentEntry => {
  const x = e as Partial<SentEntry> | null;
  return !!x && typeof x.telegramChatId === 'string' && Number.isSafeInteger(x.messageId)
    && typeof x.chatId === 'string' && Number.isFinite(x.at);
};

/**
 * The log of what Tars's own Telegram bot sent for a chat: Telegram's chat and
 * message ids and the chat's id, never the text, in ~/.tars-private (agents
 * are not handed it). Telegram numbers messages per chat, so an entry is the
 * pair of ids.
 */
export function createChatSentLog(file: string): ChatSentLog {
  const read = (now: number): SentEntry[] => {
    try {
      const entries = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { entries?: unknown }).entries;
      return Array.isArray(entries) ? entries.filter(isEntry).filter((e) => e.at > now - CHAT_SENT_KEPT_MS) : [];
    } catch {
      return [];
    }
  };
  return {
    record({ telegramChatId, messageId, chatId }, now = Date.now()) {
      const entries = read(now).filter((e) => !(e.telegramChatId === telegramChatId && e.messageId === messageId));
      entries.push({ telegramChatId, messageId, chatId, at: now });
      try {
        writeSecretFileSync(file, JSON.stringify({ entries: entries.slice(-CHAT_SENT_MAX) }));
      } catch (err) {
        console.error(`[chat-addressing] could not record ${file}:`, err instanceof Error ? err.message : err);
      }
    },
    chatOf(telegramChatId, messageId, now = Date.now()) {
      return read(now).find((e) => e.telegramChatId === telegramChatId && e.messageId === messageId)?.chatId;
    },
  };
}

export type ChannelRoute =
  /** Main, or a project with no chats: the orchestrator, by the path each bot has always taken. */
  | { kind: 'orchestrator'; text: string }
  /** Another chat: through the chats (chat-runners.ts), within their limit. */
  | { kind: 'chat'; chat: Chat; text: string }
  | { kind: 'unknown'; list: string }
  /** A reply to a chat deleted since: it reaches nobody, and the sender is told. */
  | { kind: 'gone' };

/**
 * Where a message from a channel goes, for a project already named: the chat
 * a reply answers (its words as written), else "#N", else the inbox.
 */
export function routeChannelMessage(input: { chats: Chat[]; projectPath: string; text: string; replyChatId?: string }): ChannelRoute {
  const text = input.text.trim();
  if (input.replyChatId) {
    const answered = input.chats.find((c) => c.id === input.replyChatId);
    if (!answered) return { kind: 'gone' };
    return answered.number === 1 ? { kind: 'orchestrator', text } : { kind: 'chat', chat: answered, text };
  }
  const address = parseChatAddress(text);
  const picked = pickChat(input.chats, input.projectPath, address?.number ?? null);
  if (picked.kind === 'none') return { kind: 'orchestrator', text };
  if (picked.kind === 'unknown') return picked;
  const said = address?.text ?? text;
  return picked.chat.number === 1 ? { kind: 'orchestrator', text: said } : { kind: 'chat', chat: picked.chat, text: said };
}
