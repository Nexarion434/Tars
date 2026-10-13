import { notSentText } from '@/components/ui/ComposerCard';
import type { ChatLimit } from '@/types/electron';

/**
 * What a chat's page makes of a send (chat:send, PR D): its answer read for
 * the page, the strip across the composer while a message is on its way and
 * after it, whether the words leave the field, "N of M working" above the
 * list, and a new chat's name from its first message. Frames: `Chat · chats ·
 * the composer, sending`, `· every slot working` and `· a new chat, its first
 * message`, in chat-redesign-a.pen. Tests: __tests__/lib/chat-send.test.ts.
 */

export type SendOutcome =
  | { kind: 'sent'; how: 'typed' | 'held' | 'launched' }
  /** chat_limit: its sentence, and the chats working, each with its Stop. */
  | { kind: 'limit'; reason: string; working: Array<{ chatId: string; title: string; since: string }> }
  | { kind: 'refused'; reason: string };

export interface ComposerStrip {
  tone: 'running' | 'waiting' | 'error' | 'idle';
  hollow?: boolean;
  emphasis?: 'error';
  text: string;
}

const HOW = new Set(['typed', 'held', 'launched']);
const UNREAD = 'Tars answered in a way this page cannot read, so nothing says the message went in';
/** A chat's title is one line of 80 characters at most (chats.json, PR 361). */
const TITLE_MAX = 80;

const isWorking = (value: unknown): value is { chatId: string; title: string; since: string } => {
  const w = value as Record<string, unknown> | null;
  return !!w && typeof w.chatId === 'string' && typeof w.title === 'string' && typeof w.since === 'string';
};

/** What chat:send answered, or what its call threw: only a success that says how reads as sent. */
export function outcomeOf(answer: unknown): SendOutcome {
  if (answer instanceof Error) return { kind: 'refused', reason: answer.message.trim() || UNREAD };
  if (!answer || typeof answer !== 'object') return { kind: 'refused', reason: UNREAD };
  const a = answer as Record<string, unknown>;
  if (a.success === true) {
    return typeof a.how === 'string' && HOW.has(a.how)
      ? { kind: 'sent', how: a.how as 'typed' | 'held' | 'launched' }
      : { kind: 'refused', reason: UNREAD };
  }
  if (typeof a.error !== 'string' || typeof a.reason !== 'string' || !a.reason.trim()) return { kind: 'refused', reason: UNREAD };
  if (a.error === 'chat_limit') {
    return { kind: 'limit', reason: a.reason, working: Array.isArray(a.working) ? a.working.filter(isWorking) : [] };
  }
  return { kind: 'refused', reason: a.reason };
}

/** The words leave the field once they went in, and only then. */
export function clearsField(outcome: SendOutcome): boolean {
  return outcome.kind === 'sent';
}

/**
 * The strip across the composer: a launch on its way, a refusal with its
 * reason, a held send, or the orchestrator at work; null when the words
 * simply go in. The limit has its own block, above the card.
 */
export function stripOf(state: { outcome: SendOutcome | null; sending: boolean; launching: boolean; working: boolean }): ComposerStrip | null {
  const { outcome } = state;
  if (state.sending) return state.launching ? { tone: 'idle', hollow: true, text: 'Starting the orchestrator with your message.' } : null;
  if (outcome?.kind === 'refused') return { tone: 'error', emphasis: 'error', text: notSentText(outcome.reason) };
  if (outcome?.kind === 'sent' && outcome.how === 'held') {
    return { tone: 'waiting', text: 'Held: something is typed in the orchestrator\'s terminal. Your message goes in once that field is clear.' };
  }
  if (state.working) return { tone: 'running', text: 'The orchestrator is working: your message goes in when its turn ends.' };
  return null;
}

/** "N of M working" above the chat list, its square idle at 0; nothing before the limit is read. */
export function workingLine(limit: Pick<ChatLimit, 'limit' | 'working'> | null): { text: string; tone: 'running' | 'idle' } | null {
  if (!limit) return null;
  return { text: `${limit.working} of ${limit.limit} working`, tone: limit.working > 0 ? 'running' : 'idle' };
}

/** A new chat's name from its first message: its first line, spaces folded, 80 characters at most. */
export function titleOf(text: string): string | null {
  const line = text.split('\n').map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!line) return null;
  if (line.length <= TITLE_MAX) return line;
  const room = line.slice(0, TITLE_MAX - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}
