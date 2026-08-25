import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ghost statuses.
 *
 * An agent's status is written by the hook scripts and by nothing else: a
 * separate process posting over HTTP from inside the agent's own turn. When
 * the post that says "idle" is lost - curl times out, the port refuses for a
 * moment, the process is killed between two of its three calls - nothing ever
 * posts it again, and the record keeps saying `running`. That is how a fleet
 * ends the day showing agents busy with a thousand seconds of silence behind
 * them, and an orchestrator waiting on a task that finished long ago.
 *
 * The hooks retry now (hooks/lib.sh). This is the other half: reading the
 * label back against the process that would have to be doing the work.
 */

vi.mock('../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
}));

vi.mock('../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
}));

vi.mock('../../../electron/services/agent-events', () => ({
  emitAgentStatus: vi.fn(),
}));

import {
  reconcileAgentStatus,
  reconcileFromRuntime,
  sweepAgentLiveness,
  beginAcpTurn,
  endAcpTurn,
  GHOST_AFTER_MS,
} from '../../../electron/services/agent-liveness';
import { agents, saveAgents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { emitAgentStatus } from '../../../electron/services/agent-events';
import { AgentStatus } from '../../../electron/types';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'running',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  endAcpTurn('agent-1');
  vi.mocked(saveAgents).mockClear();
  vi.mocked(emitAgentStatus).mockClear();
});

describe('reconcileAgentStatus', () => {
  it('leaves a working agent alone', () => {
    const agent = makeAgent({ ptyId: 'pty-1' });
    expect(reconcileAgentStatus(agent, { ptyAlive: true, acpInFlight: false, now: NOW })).toBe(false);
    expect(agent.status).toBe('running');
  });

  it('corrects running to idle when the PTY that would do the work is gone', () => {
    // No grace period is owed to a process that does not exist: nothing is
    // left that could ever post this agent's status again.
    const agent = makeAgent({ ptyId: 'pty-1' });
    expect(reconcileAgentStatus(agent, { ptyAlive: false, acpInFlight: false, now: NOW })).toBe(true);
    expect(agent.status).toBe('idle');
  });

  it('corrects running to idle after a long silence even with a live PTY', () => {
    // The reported case: the process is alive and parked at its prompt, the
    // Stop hook's curl never arrived, and the label stayed.
    const agent = makeAgent({
      ptyId: 'pty-1',
      lastActivity: new Date(NOW - GHOST_AFTER_MS - 1_000).toISOString(),
    });
    expect(reconcileAgentStatus(agent, { ptyAlive: true, acpInFlight: false, now: NOW })).toBe(true);
    expect(agent.status).toBe('idle');
  });

  it('holds its nerve just under the threshold', () => {
    const agent = makeAgent({
      ptyId: 'pty-1',
      lastActivity: new Date(NOW - GHOST_AFTER_MS + 1_000).toISOString(),
    });
    expect(reconcileAgentStatus(agent, { ptyAlive: true, acpInFlight: false, now: NOW })).toBe(false);
    expect(agent.status).toBe('running');
  });

  it('never touches a waiting agent, which is motionless on purpose', () => {
    // An agent parked at a permission dialog emits nothing for as long as
    // nobody answers it. Reconciling that would break the state this is
    // meant to protect: /wait already treats waiting as terminal.
    const agent = makeAgent({
      status: 'waiting',
      waitingReason: 'permission',
      ptyId: 'pty-1',
      lastActivity: new Date(NOW - GHOST_AFTER_MS * 3).toISOString(),
    });
    expect(reconcileAgentStatus(agent, { ptyAlive: true, acpInFlight: false, now: NOW })).toBe(false);
    expect(agent.status).toBe('waiting');
    expect(agent.waitingReason).toBe('permission');
  });

  it('never touches an agent with an ACP turn in flight', () => {
    // ACP delegation runs beside the terminal, not in it: no PTY output at
    // all, for as long as the turn lasts. It is the one silent `running`
    // that is the truth.
    const agent = makeAgent({
      ptyId: 'pty-1',
      lastActivity: new Date(NOW - GHOST_AFTER_MS * 2).toISOString(),
    });
    expect(reconcileAgentStatus(agent, { ptyAlive: false, acpInFlight: true, now: NOW })).toBe(false);
    expect(agent.status).toBe('running');
  });

  it('leaves an agent that never had a PTY and is not yet silent', () => {
    const agent = makeAgent({ ptyId: undefined });
    expect(reconcileAgentStatus(agent, { ptyAlive: false, acpInFlight: false, now: NOW })).toBe(false);
    expect(agent.status).toBe('running');
  });
});

describe('reconcileFromRuntime', () => {
  it('reads the live PTY map and the ACP register for itself', () => {
    const agent = makeAgent({ ptyId: 'pty-1' });
    ptyProcesses.set('pty-1', {} as never);
    expect(reconcileFromRuntime(agent, NOW)).toBe(false);

    ptyProcesses.delete('pty-1');
    expect(reconcileFromRuntime(agent, NOW)).toBe(true);
    expect(agent.status).toBe('idle');
  });

  it('respects a turn opened with beginAcpTurn', () => {
    const agent = makeAgent({ ptyId: 'pty-1' });
    beginAcpTurn('agent-1');
    expect(reconcileFromRuntime(agent, NOW)).toBe(false);

    endAcpTurn('agent-1');
    expect(reconcileFromRuntime(agent, NOW)).toBe(true);
  });
});

describe('the sweep', () => {
  it('corrects every ghost in one pass, persists once and emits per agent', () => {
    agents.set('ghost-a', makeAgent({ id: 'ghost-a', ptyId: 'dead-a' }));
    agents.set('ghost-b', makeAgent({ id: 'ghost-b', ptyId: 'dead-b' }));
    agents.set('busy', makeAgent({ id: 'busy', ptyId: 'live' }));
    ptyProcesses.set('live', {} as never);

    const corrected = sweepAgentLiveness(NOW);

    expect(corrected.sort()).toEqual(['ghost-a', 'ghost-b']);
    expect(agents.get('busy')!.status).toBe('running');
    expect(saveAgents).toHaveBeenCalledTimes(1);
    expect(emitAgentStatus).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when the fleet is honest', () => {
    agents.set('busy', makeAgent({ id: 'busy', ptyId: 'live' }));
    ptyProcesses.set('live', {} as never);

    expect(sweepAgentLiveness(NOW)).toEqual([]);
    expect(saveAgents).not.toHaveBeenCalled();
    expect(emitAgentStatus).not.toHaveBeenCalled();
  });
});
