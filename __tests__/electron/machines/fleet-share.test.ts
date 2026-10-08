import { describe, it, expect } from 'vitest';
import { shareAgent, shareFleet, readFleet, remoteId, parseRemoteId, MAX_SHARED_AGENTS } from '../../../electron/services/machines/fleet-share';
import type { AgentStatus } from '../../../electron/types';

/**
 * What a paired machine is shown of this one's agents (bridge `GET
 * /machines/v1/fleet`), and what this one takes from another's answer. How
 * it can fail, written before the code (2026-10-08):
 *
 * Sharing, on the machine the agents run on:
 * 1. A field nobody chose goes out: the terminal history, a token, the env,
 *    the CLI path, the worktree or second project path, the session id, the
 *    skills, the permission mode, who asked for the work. A field added to
 *    AgentStatus later goes out too unless it is picked here.
 * 2. A string goes out unbounded: a task or a stop reason of a megabyte.
 * 3. An agent whose id could break the remote id or a URL (a colon, a slash,
 *    empty, very long) is shared, so the other machine names a path with it.
 * 4. The project's name is wrong for a Windows path or a trailing separator,
 *    so the other machine files the agent under the wrong project.
 * 5. A field of the wrong type passes through (a status that is an object).
 * 6. One bad record throws and the whole fleet is lost, or a refused agent
 *    goes out in the list anyway.
 *
 * Reading, on the machine that shows them (the other side may be another
 * version, buggy, or not Tars at all):
 * 7. A body that is not a fleet throws, or yields agents.
 * 8. A remote agent keeps a field the share would not have sent, a string
 *    unbounded, an id that breaks the remote id, a wrong type.
 * 9. Thousands of agents are taken.
 * 10. The remote id of one machine's agent can be read as another machine's,
 *    or as a local id.
 */

const SECRET = 'tok-SECRET-1234567890';

function agent(over: Partial<AgentStatus> & Record<string, unknown> = {}): AgentStatus {
  return {
    id: 'a1b2c3', name: 'Backend Engineer', status: 'running', provider: 'claude', model: 'opus',
    character: 'robot', projectPath: '/Users/nicolas/projects/tars', branchName: 'feat/backend',
    currentTask: 'fix the scroll lock', lastActivity: '2026-10-08T12:00:00.000Z', skills: ['secret-skill'],
    output: [`export TOKEN=${SECRET}`], cliPath: `/opt/${SECRET}/claude`, worktreePath: `/w/${SECRET}`,
    secondaryProjectPath: `/second/${SECRET}`, currentSessionId: `sess-${SECRET}`, permissionMode: 'bypassPermissions',
    requestedBy: { agentId: `asker-${SECRET}` }, env: { API_KEY: SECRET }, token: SECRET,
    ...over,
  } as unknown as AgentStatus;
}

describe('sharing an agent', () => {
  it('1. sends the picked fields and nothing else, whatever the record holds', () => {
    const shared = shareAgent(agent({ cliRunning: true, stoppedBy: 'Mac', stopReason: 'night' } as never));
    expect(shared).toEqual({
      id: 'a1b2c3', name: 'Backend Engineer', status: 'running', provider: 'claude', model: 'opus',
      character: 'robot', projectName: 'tars', projectPath: '/Users/nicolas/projects/tars', branch: 'feat/backend',
      currentTask: 'fix the scroll lock', lastActivity: '2026-10-08T12:00:00.000Z', cliRunning: true,
      stoppedBy: 'Mac', stopReason: 'night',
    });
    expect(JSON.stringify(shared)).not.toContain(SECRET);
    expect(JSON.stringify(shared)).not.toContain('secret-skill');
  });

  it('2. cuts every string, a megabyte task included', () => {
    const big = 'x'.repeat(1_000_000);
    const shared = shareAgent(agent({ name: big, currentTask: big, stopReason: big, branchName: big, model: big, projectPath: `/p/${big}` }))!;
    expect(JSON.stringify(shared).length).toBeLessThan(4_000);
    expect(shared.currentTask!.length).toBeLessThanOrEqual(500);
  });

  it('2. takes control characters out of what is shown as text', () => {
    const shared = shareAgent(agent({ currentTask: 'run\x1b[31m red\x07 now\nnext', name: 'A\x00B' }))!;
    expect(shared.currentTask).toBe('run[31m red now\nnext');
    expect(shared.name).toBe('AB');
  });

  it('3. refuses an agent whose id could break a remote id or a URL', () => {
    for (const id of ['', 'a:b', 'a/b', '..', 'a b', 'x'.repeat(65), 'é']) expect(shareAgent(agent({ id })), id).toBeNull();
    expect(shareAgent(agent({ id: 'agent-1_A' }))).not.toBeNull();
  });

  it('4. names the project by its folder, on Windows and with a trailing separator', () => {
    expect(shareAgent(agent({ projectPath: 'C:\\Users\\nicol\\sakartvelo' }))!.projectName).toBe('sakartvelo');
    expect(shareAgent(agent({ projectPath: '/Users/nicolas/tars/' }))!.projectName).toBe('tars');
    expect(shareAgent(agent({ projectPath: 'D:\\code\\1212-Capital\\' }))!.projectName).toBe('1212-Capital');
    expect(shareAgent(agent({ projectPath: '' }))!.projectName).toBe('');
  });

  it('5. drops a field of the wrong type rather than sending it', () => {
    const shared = shareAgent(agent({ status: { evil: 1 } as never, model: 42 as never, cliRunning: 'yes' } as never))!;
    expect(shared.status).toBe('unknown');
    expect(shared.model).toBeUndefined();
    expect(shared.cliRunning).toBe(false);
  });

  it('6. a fleet goes out without the agents it refused, and one bad record loses nothing else', () => {
    const fleet = shareFleet([agent({ id: 'good' }), agent({ id: 'bad:id' }), null as never, agent({ id: 'also-good', name: undefined })]);
    expect(fleet.map(a => a.id)).toEqual(['good', 'also-good']);
  });
});

describe('reading another machine fleet', () => {
  const machine = { id: 'm-0123456789abcdef', name: 'PC', status: 'connected' as const };

  it('7. a body that is not a fleet gives no agents and never throws', () => {
    for (const body of [null, undefined, 'x', 42, [], {}, { agents: 'x' }, { agents: {} }]) {
      expect(readFleet(body as never, machine), JSON.stringify(body)).toEqual([]);
    }
  });

  it('8. keeps the picked fields only, bounded, with its own remote id', () => {
    const [a] = readFleet({ agents: [{ ...shareAgent(agent())!, output: [SECRET], cliPath: SECRET, currentTask: 'y'.repeat(10_000) }] }, machine);
    expect(a.id).toBe('m:m-0123456789abcdef:a1b2c3');
    expect(a.agentId).toBe('a1b2c3');
    expect(a.machine).toEqual(machine);
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(a.currentTask!.length).toBeLessThanOrEqual(500);
  });

  it('8. drops an agent whose id breaks the remote id, and wrong types', () => {
    const agents = readFleet({ agents: [{ id: 'a:b', name: 'x' }, { id: 'ok', name: 7, status: [], cliRunning: 1, projectName: {}, projectPath: 5 }] }, machine);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: 'm:m-0123456789abcdef:ok', name: '', status: 'unknown', cliRunning: false, projectName: '', projectPath: '' });
  });

  it('9. takes at most MAX_SHARED_AGENTS agents', () => {
    const many = Array.from({ length: MAX_SHARED_AGENTS + 50 }, (_, i) => ({ id: `a${i}`, name: 'n' }));
    expect(readFleet({ agents: many }, machine)).toHaveLength(MAX_SHARED_AGENTS);
  });

  it('10. a remote id names one machine and one agent, and nothing local reads as one', () => {
    expect(remoteId('m-0123456789abcdef', 'a1')).toBe('m:m-0123456789abcdef:a1');
    expect(parseRemoteId('m:m-0123456789abcdef:a1')).toEqual({ machineId: 'm-0123456789abcdef', agentId: 'a1' });
    for (const id of ['a1', 'm:a1', 'm:m-0123456789abcdef', 'm:m-0123456789abcdef:', 'm:m-0123456789abcdef:a:b', 'm:x:a1', `m:m-0123456789abcdef:${'a'.repeat(65)}`]) {
      expect(parseRemoteId(id), id).toBeNull();
    }
  });
});
