import type { AgentStatus } from '../types';
import { agents } from './agent-manager';
import { readAppSettingsFromDisk } from '../providers/cli-provider';

/**
 * Who "the project's orchestrator" is, for whoever writes to it (the kanban's
 * and the error triage's notes, the stall reports, the bots, the relay): the
 * project's inbox chat (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6; PR F of 2.0.0).
 * The inbox is chat 1, Main, the orchestrator itself, unless the user made
 * another chat the inbox; a project with no chats has its orchestrator alone.
 *
 * The chats are read through a lookup services/chat-runners.ts sets when it
 * starts, so these senders do not load the runner service (and the sleep, the
 * stall watch and the bus behind it).
 */

/** The inbox chat's agent (undefined: its runner not made yet), or null when the project has no chats. */
type InboxLookup = (projectPath: string) => { agent: AgentStatus | undefined } | null;

/** A chat as the senders name it. */
export interface ChatName { id: string; projectPath: string; number: number; title: string }

let lookup: InboxLookup | undefined;
let runBy: ((agent: AgentStatus) => ChatName | undefined) | undefined;

export function setInboxLookup(fn: InboxLookup | undefined, chatRunByFn?: (agent: AgentStatus) => ChatName | undefined): void {
  lookup = fn;
  runBy = chatRunByFn;
}

/** The chat an agent runs, when the fleet confirms it: Main for the orchestrator, its own for a runner. */
export function chatNameOf(agent: AgentStatus): ChatName | undefined {
  return runBy?.(agent);
}

const sameProject = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The project's orchestrator: its role, never a chat's runner. */
export function leadOf(projectPath: string): AgentStatus | undefined {
  return [...agents.values()].find((a) => a.role === 'orchestrator' && a.kind !== 'chat' && sameProject(a.projectPath, projectPath));
}

/**
 * Who a note for "the project's orchestrator" is typed into: the inbox chat's
 * runner, Main's being the orchestrator; the orchestrator when the project has
 * no chats. Undefined when the inbox has no runner yet: a note never starts one.
 */
export function inboxAgentOf(projectPath: string): AgentStatus | undefined {
  const found = lookup?.(projectPath);
  return found ? found.agent : leadOf(projectPath);
}

/**
 * The cross-chat reading tools for this agent's next CLI (4.4 item 5): only an
 * agent that runs a chat, and only while the user has turned the option on.
 * The route checks both again at every call (api-routes/chat-read-routes.ts).
 */
export function chatsReadEnv(agentId: string): { TARS_CHATS_READ?: '1' } {
  const agent = agents.get(agentId);
  return agent && chatNameOf(agent) && readAppSettingsFromDisk().chatsReadEachOther === true ? { TARS_CHATS_READ: '1' } : {};
}
