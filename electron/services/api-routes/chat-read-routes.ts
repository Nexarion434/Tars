import { RouteApp, RouteContext } from './types';
import { agents } from '../../core/agent-manager';
import { allChats, chatRunBy, isLive, runnerOf } from '../chat-runners';
import { chatsReadable, type ChatListed } from '../chat-addressing';
import type { Chat } from '../chats';

/**
 * The cross-chat reading option (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 5;
 * PR F of 2.0.0): a project's chats may read one another, when the user turns
 * chatsReadEachOther on (Settings, off by default). Read at every call, so
 * turning it off closes the door at once; the tools themselves are given to a
 * chat's CLI only at its launch with the setting on (TARS_CHATS_READ).
 *
 * The reader is the chat its caller runs, as the fleet confirms it from the
 * caller's own token: never a project or a chat named in the call. Read only:
 * nothing here sends into, steers, renames or settles another chat.
 */
function stateOf(chat: Chat): Exclude<ChatListed['state'], 'settled'> {
  const runner = runnerOf(chat);
  if (!runner) return 'not started';
  if (runner.status === 'asleep' || !isLive(runner)) return 'asleep';
  return runner.status === 'running' ? 'working' : 'idle';
}

export function registerChatReadRoutes(app: RouteApp, ctx: RouteContext): void {
  // GET /api/chats/list: chat_list, the other chats of the caller's project.
  app.get('/api/chats/list', async (req, sendJson) => {
    if (ctx.getAppSettings().chatsReadEachOther !== true) {
      sendJson({ error: 'chats_read_off', reason: "The project's chats do not read one another: the user has not turned it on (Settings, Agents)." }, 403);
      return;
    }
    const caller = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
    const reader = caller ? chatRunBy(caller) : undefined;
    if (!reader) {
      sendJson({ error: 'not_a_chat', reason: "Only a chat's orchestrator reads the project's other chats." }, 403);
      return;
    }
    sendJson({ chats: chatsReadable(reader, allChats(), stateOf) });
  });
}
