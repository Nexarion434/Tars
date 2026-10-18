import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * How the orchestrator's tools say to follow a task that waits its turn
 * (one task at a time, 2.0.4), after the Audit's L3 on #449: wait_for_agent
 * follows the agent's current turn, which is the other task's, and a task
 * given with start_agent that waited its turn and went in read as starting for
 * ever.
 *
 * How it fails, written before the code (2026-10-18):
 * 1. start_agent's answer for a queued task sends its caller to wait_for_agent,
 *    which follows the task the agent works on now, not this one; or it does
 *    not name the task's id to follow with task_status.
 * 2. delegate_task, its task typed into the terminal and queued there, says
 *    the same.
 * 3. task_status of a task that waited its turn and went into the agent's
 *    terminal says it is still queued, or says nothing of where it went.
 * 4. (the Audit's H-A on 9d9a7ad9) delegate_task's auto-continue, the answer
 *    to the question its own task asked, is sent as a task: it then waits in
 *    the agent's queue behind any task there, which waits for that very turn.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: '', projectPath: '' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

async function tool(name: string) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  registerAgentTools({ tool: (n: string, _d: unknown, _s: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => { tools.set(n, handler); } } as never);
  return tools.get(name)!;
}

type Result = { content: { text: string }[]; isError?: boolean };

const QUEUED = {
  success: true, mode: 'queued', queued: true, queuedTask: 't-0000beef',
  queuedBehind: 'task t-1 from "Lead", since 2026-10-18T01:00:00.000Z', agent: { id: 'a1', name: 'Worker', status: 'running' },
};

beforeEach(() => {
  mockApiRequest = vi.fn();
  vi.resetModules();
});

describe('a task queued behind another, as the tools say to follow it', () => {
  it('1. start_agent: follow it with task_status by its id, not wait_for_agent', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/dispatch')) return QUEUED;
      return { agent: { id: 'a1', name: 'Worker', status: 'running' } };
    });
    const said = ((await (await tool('start_agent'))({ id: 'a1', prompt: 'fix it' })) as Result).content[0].text;
    expect(said).toContain('queued as t-0000beef');
    expect(said).toContain('task_status({ taskId: "t-0000beef" })');
    expect(said).not.toMatch(/wait_for_agent follows it/);
  });

  it('2. delegate_task typed into the terminal and queued there: the same', async () => {
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('opencode has no ACP mode; use /dispatch'), { status: 409, body: { retryWithDispatch: true } });
      if (endpoint.includes('/dispatch')) return QUEUED;
      return { agent: { id: 'a1', name: 'Worker', status: 'running' } };
    });
    const said = ((await (await tool('delegate_task'))({ id: 'a1', prompt: 'fix it' })) as Result).content[0].text;
    expect(said).toContain('queued as t-0000beef');
    expect(said).toContain('task_status({ taskId: "t-0000beef" })');
    expect(said).not.toMatch(/use wait_for_agent to follow it/);
  });

  it('4. delegate_task\'s auto-continue is an answer, not a task: it carries no intent', async () => {
    let waits = 0;
    mockApiRequest.mockImplementation(async (endpoint: string) => {
      if (endpoint.includes('/run-task')) throw Object.assign(new Error('opencode has no ACP mode; use /dispatch'), { status: 409, body: { retryWithDispatch: true } });
      if (endpoint.includes('/dispatch')) return { success: true, mode: 'message', agent: { id: 'a1', name: 'Worker', status: 'running' } };
      if (endpoint.includes('/wait')) return (waits++ === 0) ? { status: 'waiting', waitingReason: 'question' } : { status: 'completed', lastCleanOutput: 'done' };
      return { agent: { id: 'a1', name: 'Worker', status: 'completed', lastCleanOutput: 'done' } };
    });
    await (await tool('delegate_task'))({ id: 'a1', prompt: 'fix it' });
    const dispatches = mockApiRequest.mock.calls.filter((c) => String(c[0]).includes('/dispatch'));
    expect(dispatches.length, JSON.stringify(dispatches)).toBeGreaterThanOrEqual(2);
    expect((dispatches[0][2] as { intent?: string }).intent, 'the task itself').toBe('task');
    const answer = dispatches[1][2] as { message?: string; intent?: string };
    expect(answer.message).toContain('continue');
    expect(answer.intent, 'the answer sent as a task').toBeUndefined();
  });

  it('3. task_status of a task that waited its turn and went in: where it went, and how to follow it now', async () => {
    mockApiRequest.mockImplementation(async () => ({
      task: { id: 't-0000beef', agentId: 'a1', outcome: 'delivered', how: 'started', deliveredAt: '2026-10-18T01:05:00.000Z', source: 'terminal' },
    }));
    const said = ((await (await tool('task_status'))({ taskId: 't-0000beef' })) as Result).content[0].text;
    expect(said).toContain('t-0000beef');
    expect(said).toContain('went into its terminal');
    expect(said).toContain('session started on it');
    expect(said).toContain('2026-10-18T01:05:00.000Z');
    expect(said).toContain('wait_for_agent');
    expect(said).not.toMatch(/queued|starts once it is free/);
  });
});
