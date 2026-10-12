import type { TaskRequest } from './task-requests';

/**
 * Who may cancel a piece of work another agent holds (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.3; the Audit's M1 and R6; PR D of 2.0.0), decided from the caller's
 * token, never from a body field.
 *
 * - **Its requester** may: the work is its own.
 * - **The project's persistent orchestrator** may, with a reason: it is chat
 *   1's runner, the team's lead and the bots' inbox, and the chat that asked is
 *   told the reason (R6: "the inbox chat may cancel any chat's task" is the
 *   real rule, written down).
 * - **Anyone else**, another chat's runner included, is refused: not_your_task.
 *
 * Only a request Tars still holds (queued, behind a draft or a turn) can be
 * taken back. One already typed into the worker's terminal is in the CLI's
 * hands: `already_delivered`, said to its owner only, so a refused caller
 * learns nothing of another chat's work.
 */

export interface CancelFleetMember {
  id: string;
  name?: string;
  projectPath: string;
  role?: string;
  kind?: string;
  taskQueue?: TaskRequest[];
}

export type CancelVerdict =
  | { ok: true; workerId: string; request: TaskRequest; by: 'requester' | 'lead' }
  | { ok: false; error: 'not_found' | 'not_your_task' | 'reason_required' | 'already_delivered'; reason: string };

const REF = /^t-[0-9a-f]{8}$/;

export function cancelVerdict(ref: unknown, callerId: string | undefined, reason: unknown, fleet: Iterable<CancelFleetMember>): CancelVerdict {
  const members = [...fleet];
  if (typeof ref !== 'string' || !REF.test(ref)) {
    return { ok: false, error: 'not_found', reason: 'No task has this id: a task id reads t- and 8 hex characters.' };
  }
  let worker: CancelFleetMember | undefined;
  let request: TaskRequest | undefined;
  for (const member of members) {
    request = member.taskQueue?.find((r) => r.ref === ref);
    if (request) { worker = member; break; }
  }
  if (!worker || !request) return { ok: false, error: 'not_found', reason: `No agent holds a task ${ref}: it ended, or was never asked.` };
  const caller = callerId ? members.find((m) => m.id === callerId) : undefined;
  let by: 'requester' | 'lead';
  if (caller && request.requesterAgentId === caller.id) {
    by = 'requester';
  } else if (caller && caller.role === 'orchestrator' && caller.kind !== 'chat' && caller.projectPath === worker.projectPath) {
    if (typeof reason !== 'string' || !reason.trim()) {
      return { ok: false, error: 'reason_required', reason: 'Cancelling a task another chat asked for needs a reason: that chat is told it.' };
    }
    by = 'lead';
  } else {
    return { ok: false, error: 'not_your_task', reason: "This task was asked for by another chat: only it, or the project's orchestrator with a reason, may cancel it." };
  }
  if (request.state !== 'queued') {
    return { ok: false, error: 'already_delivered', reason: "This task is already in the worker's terminal, where Tars cannot take it back: stop the worker to end it." };
  }
  return { ok: true, workerId: worker.id, request, by };
}
