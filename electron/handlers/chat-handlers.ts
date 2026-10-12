import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { ptyProcesses } from '../core/pty-manager';
import { agentStatusEmitter } from '../services/agent-events';
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
  'system:chatLimit',
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

export function registerChatHandlers(deps: { agents: Map<string, AgentStatus>; file?: string }): ChatStore {
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
  const answer = (result: Chat | ChatError): ChatView | ChatError => ('error' in result ? result : view(result));
  /** The session a runner registered, added to its chats (hooks-routes.ts records it as resumableSessionId). */
  const mirror = (agentId: string): void => {
    const agent = agents.get(agentId);
    if (agent?.resumableSessionId) store.noteSession(agent.id, agent.resumableSessionId);
  };

  // The migration, at the launch (4.6), then any session registered while
  // Tars was not running to see it: both write only what is new.
  store.ensureMains(orchestrators());
  for (const id of agents.keys()) mirror(id);
  agentStatusEmitter.on('fleet-change', mirror);

  ipcMain.handle('chat:list', () => {
    // A project whose orchestrator was set since the launch gets its Main now.
    store.ensureMains(orchestrators());
    const { seq, chats } = store.list();
    return { seq, chats: chats.map(view), problem: store.problem() };
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
  ipcMain.handle('chat:delete', (_e, raw: unknown) => store.remove(argsOf(raw).chatId, (chat) => workOutOf(chat.runnerId, agents.values())));
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
