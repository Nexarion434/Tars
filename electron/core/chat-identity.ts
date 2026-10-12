import type { AgentStatus } from '../types';
import { envelopeValue } from '../utils/envelope-value';

/** A chat as its runner is told of it. */
export interface ChatNaming {
  title: string;
  number: number;
}

let lookup: ((chatId: string) => ChatNaming | undefined) | undefined;

/**
 * Where the chats are read: set by services/chat-runners.ts when it starts,
 * so the API routes tell a runner who it is without loading the runner
 * service (and the sleep, the kanban and the bus behind it).
 */
export function setChatLookup(fn: ((chatId: string) => ChatNaming | undefined) | undefined): void {
  lookup = fn;
}

/**
 * What a runner is told of itself, in its bootstrap and its launch's header:
 * the orchestrator of one chat among several, and how its workers answer it.
 * Undefined for an agent that runs no chat of its own.
 */
export function chatIdentityOf(agent: Pick<AgentStatus, 'kind' | 'chatId'>): string | undefined {
  if (agent.kind !== 'chat') return undefined;
  const chat = agent.chatId ? lookup?.(agent.chatId) : undefined;
  const which = chat ? `the chat ${envelopeValue(chat.title)} (#${chat.number})` : "one of the project's chats";
  return `You are the orchestrator in ${which}: the project's other chats may be running at once, each its own conversation with the same team. `
    + 'Your workers answer you with send_message to "requester".';
}
