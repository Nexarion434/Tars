import { ipcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { ptyProcesses } from '../core/pty-manager';
import { agentStatusEmitter } from '../services/agent-events';
import { chatLimitOf, createChatStore, workOutOf, type Chat, type ChatError, type ChatLimit, type ChatStore, type OrchestratorFacts } from '../services/chats';
import { chatsWorking, renameRunner, sendToChat, settleRunner, startChatRunners, tearDownRunner } from '../services/chat-runners';
import { getProvider } from '../providers';
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
 * "new interface" switch. A send reaches the chat's runner, made at its first
 * send (services/chat-runners.ts, PR D).
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
  /** A permission its CLI asked Tars, shown in the chat that runs it (#318). */
  permissionAsk: AgentStatus['permissionAsk'] | null;
}

export type ChatView = Chat & { runner: ChatRunnerView | null };

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

  const orchestrators = (): OrchestratorFacts[] => [...agents.values()].filter((a) => isSuperAgent(a) && a.kind !== 'chat').map((a) => ({
    id: a.id, projectPath: a.projectPath, createdAt: a.createdAt, lastActivity: a.lastActivity, resumableSessionId: a.resumableSessionId,
    // A chat other than Main resumes its conversation at each launch: claude only, for now.
    resumable: getProvider(a.provider).binaryName === 'claude',
  }));
  const isLive = (agent: AgentStatus): boolean => !!agent.ptyId && ptyProcesses.has(agent.ptyId);
  const view = (chat: Chat): ChatView => {
    const runner = chat.runnerId ? agents.get(chat.runnerId) : undefined;
    return {
      ...chat,
      runner: runner ? {
        id: runner.id, name: runner.name || runner.id, status: runner.status, waking: !!runner.waking, live: isLive(runner),
        lastActivity: runner.lastActivity, permissionAsk: runner.permissionAsk ?? null,
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
  startChatRunners(store);

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
  ipcMain.handle('chat:rename', (_e, raw: unknown) => {
    const renamed = store.rename(argsOf(raw).chatId, argsOf(raw).title);
    if (!('error' in renamed)) renameRunner(renamed);
    return answer(renamed);
  });
  ipcMain.handle('chat:pin', (_e, raw: unknown) => answer(store.pin(argsOf(raw).chatId, argsOf(raw).pinned)));
  ipcMain.handle('chat:snooze', (_e, raw: unknown) => answer(store.snooze(argsOf(raw).chatId, argsOf(raw).until)));
  ipcMain.handle('chat:settle', (_e, raw: unknown) => {
    const settled = store.settle(argsOf(raw).chatId, argsOf(raw).settled);
    // Its runner sleeps at once, or as soon as the rule allows it; Main's never does.
    if (!('error' in settled) && settled.settledAt) settleRunner(settled);
    return answer(settled);
  });
  ipcMain.handle('chat:setInbox', (_e, raw: unknown) => answer(store.setInbox(argsOf(raw).chatId)));
  // Refused for the inbox and while the chat's runner has a request out at the
  // team (PR A's queue); then its own runner is stopped and removed with its
  // worktree, its work saved first, and the record goes. Main's runner, the
  // orchestrator, stays.
  ipcMain.handle('chat:delete', async (_e, raw: unknown) => {
    const chatId = argsOf(raw).chatId;
    const workOut = (chat: Chat) => workOutOf(chat.runnerId, agents.values());
    const refused = store.removalRefusal(chatId, workOut);
    if (refused) return refused;
    const torn = await tearDownRunner(store.get(chatId)!);
    const removed = store.remove(chatId, workOut);
    return 'error' in removed ? removed : { ...removed, ...torn };
  });
  // The user's words into the chat's runner, made at its first send, within the limit.
  // clientRequestId and the send modes come with PR B's receipts.
  ipcMain.handle('chat:send', (_e, raw: unknown) => sendToChat(argsOf(raw).chatId, argsOf(raw).text));

  ipcMain.handle('system:chatLimit', (): ChatLimit & { working: number } => (
    { ...chatLimitOf(os.totalmem(), process.env), working: chatsWorking() }
  ));

  return store;
}
