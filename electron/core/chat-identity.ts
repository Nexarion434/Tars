import type { AgentStatus } from '../types';
import { envelopeValue } from '../utils/envelope-value';

/** A chat as its runner, or a refusal, names it. */
export interface ChatNaming {
  title: string;
  number: number;
}

/** Where the chats are read: set by services/chat-runners.ts when it starts. */
export interface ChatLookup {
  /** A chat by its id. */
  byId(chatId: string): ChatNaming | undefined;
  /** The chat this agent runs, as the fleet confirms its record: Main's runner is the project's orchestrator. */
  byRunner(agentId: string): ChatNaming | undefined;
}

let lookup: ChatLookup | undefined;
let follow: (() => void) | undefined;

/**
 * The chats, handed in by the runner service when it starts, so the API routes
 * name a chat without loading that service (and the sleep, the kanban and the
 * bus behind it).
 */
export function setChatLookup(chats: ChatLookup | undefined): void {
  lookup = chats;
}

/**
 * What a runner is told of itself, in its bootstrap and its launch's header:
 * the orchestrator of one chat among several, and how its workers answer it.
 * Undefined for an agent that runs no chat of its own.
 */
export function chatIdentityOf(agent: Pick<AgentStatus, 'kind' | 'chatId'>): string | undefined {
  if (agent.kind !== 'chat') return undefined;
  const chat = agent.chatId ? lookup?.byId(agent.chatId) : undefined;
  const which = chat ? `the chat ${envelopeValue(chat.title)} (#${chat.number})` : "one of the project's chats";
  return `You are the orchestrator in ${which}: the project's other chats may be running at once, each its own conversation with the same team. `
    + 'Your workers answer you with send_message to "requester".';
}

/** The chat whose work an asker's requests are, when it runs one: what a refused steer or restart names. */
export function chatOfAsker(agentId: string | undefined): ChatNaming | undefined {
  return agentId ? lookup?.byRunner(agentId) : undefined;
}

/** Set by the chats' handlers: what follows a move of a project's orchestrator role. */
export function setOrchestratorFollower(fn: (() => void) | undefined): void {
  follow = fn;
}

/**
 * A project's orchestrator role was given (assignRole, once the fleet holds the
 * agent): its Main follows it, the project's persistent orchestrator. Nothing
 * before the chats are loaded.
 */
export function orchestratorMoved(): void {
  follow?.();
}
