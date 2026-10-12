import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { ptyProcesses } from '../core/pty-manager';
import { agentStatusEmitter } from '../services/agent-events';
import { chatSeq, followChats, historyOf, noteChatSnapshot, publishChatEvent, queueOf, readChatItems } from '../services/chat-history';
import { broadcastToAllWindows } from '../utils/broadcast';
import { chatLimitOf, createChatStore, workOutOf, type Chat, type ChatError, type ChatLimit, type ChatStore, type OrchestratorFacts } from '../services/chats';
import type { AgentStatus } from '../types';
import { isSuperAgent } from '../utils';

/**
 * The window's channels for the chats' records (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.5, the records' part; PR C of 2.0.0), over services/chats.ts.
 *
 * Registered at launch, which runs the migration first: each project's
 * orchestrator's conversation is its chat #1, Main. A chat's runner is read
 * from the fleet as it is (Main's is the orchestrator); every session that
 * runner registers is added to its chats' sessions. Nothing in the window
 * calls these yet: the Frontend builds the chat pages on them behind the
 * "new interface" switch. `chat:send` refuses, with its reason, until the
 * chats have runners of their own (PR D).
 */

export const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

export const CHAT_CHANNELS = [
  'chat:list', 'chat:create', 'chat:rename', 'chat:pin', 'chat:snooze', 'chat:settle', 'chat:delete', 'chat:setInbox', 'chat:send',
  'system:chatLimit', 'chat:history', 'agent:queue',
] as const;

/** What the window learns of a chat's runner: the agent as it is now. */
export interface ChatRunnerView {
  id: string;
  name: string;
  status: AgentStatus['status'];
  waking: boolean;
  /** Its CLI holds a terminal: it counts in the limit. */
  live: boolean;
  lastActivity: string;
}

export type ChatView = Chat & { runner: ChatRunnerView | null };

const SEND_REFUSED: ChatError = {
  error: 'chat_send_unavailable',
  reason: "This version keeps the chats' records only: writing in a chat comes with the chats' own orchestrators. Until then, write to the project's orchestrator on the Dashboard.",
};

let live: ChatStore | null = null;

/** The store, once main.ts has registered the channels; null before that and in the tests of everything else. */
export function liveChatStore(): ChatStore | null {
  return live;
}

const argsOf = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {});

export function registerChatHandlers(deps: {
  agents: Map<string, AgentStatus>;
  file?: string;
  /** Whether a window can show chats (the new interface): the follower reads nothing otherwise. */
  chatsShown?: () => boolean;
}): ChatStore {
  const { agents } = deps;
  const store = createChatStore({ file: deps.file ?? CHATS_FILE });
  live = store;

  const orchestrators = (): OrchestratorFacts[] => [...agents.values()].filter(isSuperAgent).map((a) => ({
    id: a.id, projectPath: a.projectPath, createdAt: a.createdAt, lastActivity: a.lastActivity, resumableSessionId: a.resumableSessionId,
  }));
  const isLive = (agent: AgentStatus): boolean => !!agent.ptyId && ptyProcesses.has(agent.ptyId);
  const view = (chat: Chat): ChatView => {
    const runner = chat.runnerId ? agents.get(chat.runnerId) : undefined;
    return {
      ...chat,
      runner: runner ? {
        id: runner.id, name: runner.name || runner.id, status: runner.status, waking: !!runner.waking, live: isLive(runner),
        lastActivity: runner.lastActivity,
      } : null,
    };
  };
  /** A chat changed: answered, and told to every window as a `meta` event (services/chat-history.ts). */
  const answer = (result: Chat | ChatError): ChatView | ChatError => {
    if ('error' in result) return result;
    const shown = view(result);
    publishChatEvent({ type: 'meta', chatId: result.id, chat: shown });
    return shown;
  };
  const nameOf = (agentId: string): string | undefined => agents.get(agentId)?.name;
  /** The session a runner registered, added to its chats (hooks-routes.ts records it as resumableSessionId). */
  const mirror = (agentId: string): void => {
    const agent = agents.get(agentId);
    if (agent?.resumableSessionId && store.noteSession(agent.id, agent.resumableSessionId)) {
      for (const chat of store.list().chats.filter((c) => c.runnerId === agent.id)) publishChatEvent({ type: 'meta', chatId: chat.id, chat: view(chat) });
    }
  };
  /** Each worker's queue, as last told: a change is told as an `agent:queue` event. */
  const queues = new Map<string, string>();
  const tellQueue = (agentId: string): void => {
    const agent = agents.get(agentId);
    if (!agent) { queues.delete(agentId); return; }
    const shown = queueOf(agent, nameOf);
    const key = JSON.stringify(shown);
    const before = queues.get(agentId);
    if (before === key) return;
    queues.set(agentId, key);
    // An agent seen for the first time (the fleet may load after this) is told
    // when it holds anything: an empty queue is no change.
    if (before !== undefined || shown.current || shown.queue.length) broadcastToAllWindows('agent:queue', shown);
  };

  // The migration, at the launch (4.6), then any session registered while
  // Tars was not running to see it: both write only what is new.
  store.ensureMains(orchestrators());
  for (const id of agents.keys()) { mirror(id); tellQueue(id); }
  agentStatusEmitter.on('fleet-change', mirror);
  agentStatusEmitter.on('fleet-change', tellQueue);
  // A request queued or delivered is saved, not announced as a fleet change:
  // every queue is looked at each second as well.
  const queueTimer = setInterval(() => { for (const id of agents.keys()) tellQueue(id); }, 1_000);
  queueTimer.unref?.();
  followChats({
    chats: () => store.list().chats,
    runnerOf: (chat) => (chat.runnerId ? agents.get(chat.runnerId) : undefined),
    isLive: (agent) => isLive(agent),
    nameOf,
    enabled: deps.chatsShown ?? (() => true),
  });

  ipcMain.handle('chat:list', () => {
    // A project whose orchestrator was set since the launch gets its Main now.
    for (const made of store.ensureMains(orchestrators())) publishChatEvent({ type: 'meta', chatId: made.id, chat: view(made) });
    const { chats } = store.list();
    // The seq of chat:events (services/chat-history.ts): this list is a snapshot at it.
    return { seq: chatSeq(), chats: chats.map(view), problem: store.problem() };
  });
  ipcMain.handle('chat:create', (_e, raw: unknown) => {
    const args = argsOf(raw);
    return answer(store.create({ projectPath: args.projectPath, title: args.title }, orchestrators()));
  });
  ipcMain.handle('chat:rename', (_e, raw: unknown) => answer(store.rename(argsOf(raw).chatId, argsOf(raw).title)));
  ipcMain.handle('chat:pin', (_e, raw: unknown) => answer(store.pin(argsOf(raw).chatId, argsOf(raw).pinned)));
  ipcMain.handle('chat:snooze', (_e, raw: unknown) => answer(store.snooze(argsOf(raw).chatId, argsOf(raw).until)));
  ipcMain.handle('chat:settle', (_e, raw: unknown) => answer(store.settle(argsOf(raw).chatId, argsOf(raw).settled)));
  ipcMain.handle('chat:setInbox', (_e, raw: unknown) => answer(store.setInbox(argsOf(raw).chatId)));
  // Refused while the chat's runner has a request out at the team (PR A's queue).
  ipcMain.handle('chat:delete', (_e, raw: unknown) => {
    const chatId = argsOf(raw).chatId;
    const result = store.remove(chatId, (chat) => workOutOf(chat.runnerId, agents.values()));
    if (!('error' in result) && typeof chatId === 'string') publishChatEvent({ type: 'deleted', chatId });
    return result;
  });
  // A chat's conversation, from its runner's transcripts, and the seq it is a snapshot at.
  ipcMain.handle('chat:history', async (_e, raw: unknown) => {
    const args = argsOf(raw);
    const chat = store.get(args.chatId);
    if (!chat) return { error: 'not_found', reason: 'No chat has this id.', seq: chatSeq() };
    const runner = chat.runnerId ? agents.get(chat.runnerId) : undefined;
    const items = await readChatItems(chat, { runner, nameOf });
    noteChatSnapshot(chat.id, items);
    return historyOf(items, { before: args.before, limit: args.limit });
  });
  // A worker's work in hand and its queue (core/task-requests.ts).
  ipcMain.handle('agent:queue', (_e, agentId: unknown) => {
    const agent = typeof agentId === 'string' ? agents.get(agentId) : undefined;
    return agent ? queueOf(agent, nameOf) : { error: 'not_found', reason: 'No agent has this id.' };
  });
  ipcMain.handle('chat:send', (_e, raw: unknown) => (store.get(argsOf(raw).chatId) ? SEND_REFUSED : { error: 'not_found', reason: 'No chat has this id.' }));

  ipcMain.handle('system:chatLimit', (): ChatLimit & { working: number } => {
    const runners = new Set(store.list().chats.map((c) => c.runnerId).filter((id): id is string => !!id));
    const working = [...runners].filter((id) => {
      const agent = agents.get(id);
      return !!agent && isLive(agent);
    }).length;
    return { ...chatLimitOf(os.totalmem(), process.env), working };
  });

  return store;
}
