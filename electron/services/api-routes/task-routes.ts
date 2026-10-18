import { agents, saveAgents } from '../../core/agent-manager';
import { ptyProcesses, withdrawWaiting } from '../../core/pty-manager';
import { requestDropped } from '../../core/task-requests';
import { cancelRight, cancelVerdict } from '../../core/task-cancel';
import { oneTaskQueue } from '../../core/one-task';
import { envelopeValue } from '../../utils/envelope-value';
import { liveChatStore } from '../../handlers/chat-handlers';
import { tellCancelled } from '../agent-watch';
import { emitAgentStatus } from '../agent-events';
import { announceTask } from '../task-banner';
import type { RouteApp } from './types';

/**
 * Taking back work asked of another agent before it went in
 * (ORCHESTRATOR-PER-CHAT.md v2.2, 4.3; the Audit's M1 and R6; PR D of 2.0.0).
 *
 * POST /api/tasks/:ref/cancel, `{ reason? }`, by the agent whose token makes
 * the call (core/task-cancel.ts says who may): the task's own requester, or
 * the project's orchestrator with a reason, which the chat that asked is told.
 * The request leaves the worker's queue, and the message that would have
 * handed it over is taken back from the worker's terminal, where it waited
 * behind a draft or a turn. A request already typed in answers
 * `already_delivered`: stopping the worker is the way to end it.
 */

const STATUS = { not_found: 404, not_your_task: 403, reason_required: 400, already_delivered: 409 } as const;

export function registerTaskRoutes(app_: RouteApp): void {
  app_.post(/^\/api\/tasks\/([^/]+)\/cancel$/, (req, sendJson) => {
    const callerId = req.callerAgentId;
    const { reason } = (req.body ?? {}) as { reason?: unknown };
    // A task waiting its turn behind the agent's work in hand (core/one-task.ts):
    // taken out of the line as a request is (core/task-cancel.ts): by its
    // asker, by the project's orchestrator with a reason, which the chat that
    // asked is told, or by Tars. No other chat cuts its work (the Audit's L2
    // on #449: any chat's runner took any queued task back, with no reason).
    const queued = oneTaskQueue.find(req.params.id);
    if (queued) {
      // The shared token names nobody: it cancels nothing.
      if (!req.internal && !callerId) {
        sendJson({ error: 'not_found', reason: `No agent holds a task ${queued.ref}: it ended, or was never asked.` }, STATUS.not_found);
        return;
      }
      const worker = agents.get(queued.agentId);
      const right = req.internal ? { ok: true as const, by: 'tars' as const } : cancelRight(agents.get(callerId!), queued.requesterId, worker?.projectPath ?? '', reason);
      if (!right.ok) {
        sendJson({ error: right.error, reason: right.reason }, STATUS[right.error]);
        return;
      }
      let byName = 'Tars';
      if (right.by === 'lead') {
        const lead = agents.get(callerId!)!;
        const chat = liveChatStore()?.chatOfRunner(lead.id);
        byName = chat ? `the chat ${envelopeValue(chat.title)}` : envelopeValue(lead.name || lead.id);
      }
      oneTaskQueue.cancel(queued.ref, right.by === 'lead' ? `it was cancelled by ${byName}` : undefined);
      announceTask(queued.agentId);
      if (right.by === 'lead' && queued.requesterId) tellCancelled(queued.requesterId, queued.agentId, byName, String(reason));
      console.log(`[tasks] ${queued.ref} queued for ${worker?.name || queued.agentId} cancelled by ${callerId ?? 'Tars'} (${right.by})`);
      sendJson({ success: true, cancelled: queued.ref, queuedRun: true, worker: { id: queued.agentId, name: worker?.name } });
      return;
    }
    const verdict = cancelVerdict(req.params.id, callerId, reason, agents.values());
    if (!verdict.ok) {
      sendJson({ error: verdict.error, reason: verdict.reason }, STATUS[verdict.error]);
      return;
    }
    const worker = agents.get(verdict.workerId)!;
    const terminal = worker.ptyId ? ptyProcesses.get(worker.ptyId) : undefined;
    // In a live terminal, a queued request's message waits in it: taken back,
    // or, when it is not there any more, it was going in as this was asked.
    if (terminal && withdrawWaiting(terminal, verdict.request.ref) === 0) {
      sendJson({ error: 'already_delivered', reason: "This task was going into the worker's terminal as you asked: stop the worker to end it." }, STATUS.already_delivered);
      return;
    }
    requestDropped(worker, verdict.request.ref);
    saveAgents();
    emitAgentStatus(worker.id);
    if (verdict.by === 'lead') {
      const lead = agents.get(callerId!)!;
      const chat = liveChatStore()?.chatOfRunner(lead.id);
      const by = chat ? `the chat ${envelopeValue(chat.title)}` : envelopeValue(lead.name || lead.id);
      tellCancelled(verdict.request.requesterAgentId, worker.id, by, String(reason));
    }
    console.log(`[tasks] ${verdict.request.ref} for ${worker.name || worker.id} cancelled by ${callerId} (${verdict.by})`);
    sendJson({ success: true, cancelled: verdict.request.ref, worker: { id: worker.id, name: worker.name } });
  });
}
