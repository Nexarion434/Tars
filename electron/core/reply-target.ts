import { hasOrchestratorPowers } from './agent-role';

/**
 * Who a message reaches when a worker names its orchestrator rather than an id
 * (ORCHESTRATOR-PER-CHAT.md v2.2, 4.3 "Replies"; the Audit's R5; PR D of 2.0.0).
 *
 * With several chats, whoever asked a worker for its current task may be a
 * chat's runner rather than the project's orchestrator. A worker that writes
 * to "requester", to "orchestrator" or to the orchestrator's name means
 * whoever asked it; an explicit id always means that id, the persistent
 * orchestrator's included: Tars never second-guesses an id. Read by /dispatch
 * and /message, which say where the message went.
 */

export interface ReplyAgent {
  id: string;
  name?: string;
  projectPath: string;
  role?: string;
  kind?: string;
  requestedBy?: { agentId: string };
}

export type ReplyTarget = { agentId: string; how: 'id' | 'requester' | 'orchestrator' };

/** The agent `raw` names for `callerId`, or null when it names none (the route then answers as before). */
export function replyTargetOf(raw: string, callerId: string | undefined, fleet: ReadonlyMap<string, ReplyAgent>): ReplyTarget | null {
  if (fleet.has(raw)) return { agentId: raw, how: 'id' };
  const caller = callerId ? fleet.get(callerId) : undefined;
  if (!caller) return null;
  const said = raw.trim().toLowerCase();
  if (!said) return null;
  // The project's own orchestrator: never a chat's runner, never another project's.
  const lead = [...fleet.values()].find((a) => a.role === 'orchestrator' && a.kind !== 'chat' && a.projectPath === caller.projectPath);
  const toRequester = said === 'requester';
  const toOrchestrator = said === 'orchestrator' || (!!lead?.name && lead.name.trim().toLowerCase() === said);
  if (!toRequester && !toOrchestrator) return null;
  const askerId = caller.requestedBy?.agentId;
  const asker = askerId && askerId !== caller.id ? fleet.get(askerId) : undefined;
  if (asker && asker.projectPath === caller.projectPath && (toRequester || hasOrchestratorPowers(asker))) {
    return { agentId: asker.id, how: 'requester' };
  }
  return lead ? { agentId: lead.id, how: 'orchestrator' } : null;
}
