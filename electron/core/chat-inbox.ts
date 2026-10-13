import type { AgentStatus } from '../types';
import { readAppSettingsFromDisk } from '../providers/cli-provider';

/**
 * Who "the project's orchestrator" is, for whoever writes to it (the kanban's
 * and the error triage's notes, the stall reports, the bots, the relay): the
 * project's inbox chat (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0).
 * The inbox is chat 1, Main, the orchestrator itself, unless the user made
 * another chat the inbox; a project with no chats has its orchestrator alone.
 *
 * The chats are read through lookups services/chat-runners.ts sets when it
 * starts, and the fleet is handed in: this module loads neither, so the agent
 * terminal's spawn (core/agent-pty.ts), the stall watch and the bus can ask it
 * without loading the runner service or the agent manager.
 */

/** A chat as the senders name it. */
export interface ChatName { id: string; projectPath: string; number: number; title: string }

export interface ChatLookups {
  /** The inbox chat's agent (undefined: its runner not made yet), or null when the project has no chats. */
  inbox(projectPath: string): { agent: AgentStatus | undefined } | null;
  /** The chat an agent runs, when the fleet confirms it: Main for the orchestrator, its own for a runner. */
  chatRunBy(agentId: string): ChatName | undefined;
  /** The same, only once its project has several chats: what is named on what it sends. */
  namedChatOf?(agentId: string): ChatName | undefined;
}

let lookups: ChatLookups | undefined;

export function setChatLookups(next: ChatLookups | undefined): void {
  lookups = next;
}

const sameProject = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The project's orchestrator in this fleet: its role, never a chat's runner. */
export function leadOf(projectPath: string, fleet: Iterable<AgentStatus>): AgentStatus | undefined {
  return [...fleet].find((a) => a.role === 'orchestrator' && a.kind !== 'chat' && sameProject(a.projectPath, projectPath));
}

/**
 * Who a note for "the project's orchestrator" is typed into: the inbox chat's
 * runner, Main's being the orchestrator; the orchestrator when the project has
 * no chats, and while the inbox chat has no runner yet (a note never makes one,
 * and went to the orchestrator before the chat was made the inbox: the
 * Audit's L3 on #386). A runner that exists, asleep or not, takes its notes.
 */
export function inboxAgentOf(projectPath: string, fleet: Iterable<AgentStatus>): AgentStatus | undefined {
  return lookups?.inbox(projectPath)?.agent ?? leadOf(projectPath, fleet);
}

/** The chat an agent runs, when the fleet confirms it. */
export function chatNameOf(agent: Pick<AgentStatus, 'id'>): ChatName | undefined {
  return lookups?.chatRunBy(agent.id);
}

/**
 * The chat an agent runs, to name on what it sends (a channel's prefix, the
 * room's author): only once its project has several chats. A project with only
 * Main reads as it did in 1.9.7, the new interface off or not
 * (GATE-2.0.0-BULLETS, 2).
 */
export function namedChatOf(agent: Pick<AgentStatus, 'id'>): ChatName | undefined {
  return lookups?.namedChatOf?.(agent.id);
}

/**
 * The cross-chat reading tools for this agent's next CLI (4.4 item 5): only an
 * agent that runs a chat, and only while the user has turned the option on.
 * The route checks both again at every call (api-routes/chat-read-routes.ts).
 */
export function chatsReadEnv(agentId: string): { TARS_CHATS_READ?: '1' } {
  return lookups?.chatRunBy(agentId) && readAppSettingsFromDisk().chatsReadEachOther === true ? { TARS_CHATS_READ: '1' } : {};
}
