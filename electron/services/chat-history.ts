import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName, transcriptRoots } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { chatItems, type ChatItem } from './chat-transcript';
import type { Chat } from './chats';
import type { AgentStatus } from '../types';

/**
 * A chat's conversation for the window (ORCHESTRATOR-PER-CHAT.md v2.2, 4.5):
 * `chat:history` reads it from its runner's transcripts, across the chat's
 * sessions, and `chat:events` follows it afterwards, "snapshot at N, then
 * events after N".
 *
 * - **seq** is one counter, in memory, reset per app run: `chat:history`
 *   answers the seq it is a snapshot at, and every event carries the next. A
 *   window that misses one (a gap, a reload) asks again from its last seq.
 *   The transcripts and chats.json are the durable state.
 * - **Items are numbered** by their place in the chat (`n`), the same in an
 *   answer and in an event, so the window can tell what it already shows.
 * - **Followed live** while the runner's CLI holds a terminal: each second its
 *   files are looked at again (a size and a time), and what they gained is
 *   sent as `item` events. A chat seen for the first time is a baseline, sent
 *   nothing.
 */

export type NumberedItem = ChatItem & { n: number };

export type ChatEvent =
  | { type: 'item'; chatId: string; item: NumberedItem }
  | { type: 'meta'; chatId: string; chat: unknown }
  | { type: 'deleted'; chatId: string }
  | { type: 'state'; chatId: string; runner: { id: string; status: AgentStatus['status']; live: boolean } | null };

let seq = 0;

export function chatSeq(): number {
  return seq;
}

/** Sent to every window, with the next seq. */
export function publishChatEvent(event: ChatEvent): number {
  seq += 1;
  broadcastToAllWindows('chat:events', { seq, ...event });
  return seq;
}

/** The Claude Code folders a chat's transcripts can be in: the default one, and each account's (`~/.claude-accounts/<id>`). */
function configDirs(homeDir: string): string[] {
  const dirs = [path.join(homeDir, '.claude')];
  const accounts = path.join(homeDir, '.claude-accounts');
  try {
    for (const name of fs.readdirSync(accounts)) dirs.push(path.join(accounts, name));
  } catch { /* no other account */ }
  return dirs;
}

/** A session's transcript, where its CLI ran: the project, or the runner's worktree, under any spelling and any account. */
function sessionFile(sessionId: string, cwds: Array<string | undefined>, homeDir: string): string | null {
  for (const dir of configDirs(homeDir)) {
    for (const root of transcriptRoots(...cwds)) {
      const file = path.join(dir, 'projects', encodeProjectDirName(root), `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** The chat's sessions in order: its record's, then its runner's own when the mirror has not caught up. */
function sessionsOf(chat: Chat, runner: AgentStatus | undefined): string[] {
  const ids = [...chat.sessionIds];
  for (const id of [runner?.resumableSessionId, runner?.currentSessionId]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** One answer per chat while none of its files has changed: a transcript can be tens of megabytes. */
const cache = new Map<string, { key: string; items: NumberedItem[] }>();

export function readChatItems(chat: Chat, deps: {
  runner?: AgentStatus;
  nameOf?: (agentId: string) => string | undefined;
  homeDir?: string;
}): NumberedItem[] {
  const homeDir = deps.homeDir ?? os.homedir();
  const files = sessionsOf(chat, deps.runner).map((sessionId) => ({ sessionId, file: sessionFile(sessionId, [deps.runner?.worktreePath, chat.projectPath], homeDir) }));
  const stats = files.map(({ file }) => {
    if (!file) return 'none';
    try {
      const st = fs.statSync(file);
      return `${file}:${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  });
  const key = JSON.stringify(stats);
  const hit = cache.get(chat.id);
  if (hit && hit.key === key) return hit.items;
  const items = chatItems(files.map(({ sessionId, file }) => {
    let text: string | null = null;
    try {
      if (file) text = fs.readFileSync(file, 'utf8');
    } catch { /* gone since: said so */ }
    return { sessionId, text };
  }), { nameOf: deps.nameOf }).map((item, n) => ({ ...item, n }));
  cache.set(chat.id, { key, items });
  return items;
}

/** `chat:history`: the items before `before` (all when absent), the last `limit` of them, oldest first. */
export function historyOf(items: NumberedItem[], query: { before?: unknown; limit?: unknown }): { seq: number; total: number; items: NumberedItem[] } {
  const before = typeof query.before === 'number' && Number.isInteger(query.before) && query.before >= 0 ? query.before : items.length;
  const limit = typeof query.limit === 'number' && Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 1_000) : 500;
  const upTo = items.filter((i) => i.n < before);
  return { seq, total: items.length, items: upTo.slice(-limit) };
}

/**
 * How many items of each chat the windows have been told of, by snapshot or
 * by event: the follower sends what comes after. The first chat:history
 * answer for a chat sets it, so a line written before the follower first sees
 * its runner live is still sent; a chat nobody asked for starts where it is
 * when its runner is first seen live.
 */
const told = new Map<string, number>();

/** A chat:history answer is a snapshot: what it held needs no event. */
export function noteChatSnapshot(chatId: string, count: number): void {
  if (!told.has(chatId)) told.set(chatId, count);
}

/**
 * Following the chats whose runner's CLI is live: the items each gained, and
 * a runner whose state changed, as events. Returns what stops it.
 */
export function followChats(deps: {
  chats: () => Chat[];
  runnerOf: (chat: Chat) => AgentStatus | undefined;
  isLive: (agent: AgentStatus) => boolean;
  nameOf: (agentId: string) => string | undefined;
  homeDir?: string;
  everyMs?: number;
}): () => void {
  const states = new Map<string, string>();
  const tick = () => {
    for (const chat of deps.chats()) {
      const runner = deps.runnerOf(chat);
      const state = runner ? `${runner.id}:${runner.status}:${deps.isLive(runner)}` : 'none';
      if (states.has(chat.id) && states.get(chat.id) !== state) {
        publishChatEvent({ type: 'state', chatId: chat.id, runner: runner ? { id: runner.id, status: runner.status, live: deps.isLive(runner) } : null });
      }
      states.set(chat.id, state);
      if (!runner || !deps.isLive(runner)) continue;
      let items: NumberedItem[];
      try {
        items = readChatItems(chat, { runner, nameOf: deps.nameOf, homeDir: deps.homeDir });
      } catch (err) {
        console.warn(`[chats] could not read chat ${chat.id}:`, (err as Error).message);
        continue;
      }
      const before = told.get(chat.id);
      told.set(chat.id, items.length);
      if (before === undefined) continue;
      for (const item of items.slice(before)) publishChatEvent({ type: 'item', chatId: chat.id, item });
    }
  };
  tick();
  const timer = setInterval(tick, deps.everyMs ?? 1_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** What `agent:queue` answers: the work in hand, and the requests waiting behind it. */
export interface QueueView {
  agentId: string;
  current: QueueEntry | null;
  queue: QueueEntry[];
}

export interface QueueEntry {
  ref: string | null;
  requesterAgentId: string;
  requesterName: string;
  state: 'queued' | 'delivered';
  queuedAt: string | null;
  /** The chat it was asked from: none until the chats have their own runners (PR D). */
  chatId: null;
}

export function queueOf(agent: AgentStatus, nameOf: (agentId: string) => string | undefined): QueueView {
  const entry = (r: { ref?: string; requesterAgentId: string; state?: 'queued' | 'delivered'; queuedAt?: string }): QueueEntry => ({
    ref: r.ref ?? null, requesterAgentId: r.requesterAgentId, requesterName: nameOf(r.requesterAgentId) ?? r.requesterAgentId,
    state: r.state ?? 'delivered', queuedAt: r.queuedAt ?? null, chatId: null,
  });
  const held = agent.requestedBy;
  const queue = agent.taskQueue ?? [];
  const inHand = held ? queue.find((r) => r.ref === held.taskRef) : undefined;
  return {
    agentId: agent.id,
    current: held ? entry(inHand ?? { ref: held.taskRef, requesterAgentId: held.agentId }) : null,
    queue: queue.filter((r) => r !== inHand).map(entry),
  };
}
