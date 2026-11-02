import { describe, it, expect } from 'vitest';
import { shareAgent, shareFleet, MAX_SHARED_AGENTS, SHARED_FIELDS } from '../../../electron/services/cloud/fleet-share';
import type { AgentStatus } from '../../../electron/types';

/**
 * What a client with `see` is shown of an agent (plan Task 6, after the fork's
 * SECURITY.md §8 "What See shows"): field by field, never a spread, so a field
 * added to the agent record later stays on the server until it is named here.
 * The terminal's history is not in it: one agent's screen travels on its own
 * route.
 *
 * How it fails:
 * - a token, an environment, a CLI path, a session id, skills, a permission
 *   mode, a worktree or a second project travelling, or any field not named
 *   in SHARED_FIELDS
 * - the master API token, or an agent's own token, anywhere in what is shared
 * - an unbounded string (name 80, task 500, path 400 characters)
 * - a control or format character kept (an escape sequence, a right-to-left
 *   override that disguises a name)
 * - an agent whose id cannot sit in a URL path shared under that id
 * - more than 200 agents, or one bad record losing the others
 * - a terminal size other than two whole numbers from 1 to 1000
 */

const MASTER = 'm'.repeat(64);

function agent(fields: Partial<AgentStatus> & Record<string, unknown> = {}): AgentStatus {
  return {
    id: 'agent-1',
    name: 'Nova',
    status: 'running',
    projectPath: '/home/tars/tars-projects/allcazz',
    provider: 'claude',
    model: 'opus',
    ...fields,
  } as unknown as AgentStatus;
}

describe('shareAgent', () => {
  it('names its fields, and nothing else travels', () => {
    const shared = shareAgent(agent({
      env: { ANTHROPIC_API_KEY: 'sk-secret' },
      apiToken: MASTER,
      terminalToken: 'tok-agent',
      cliPath: '/usr/local/bin/claude',
      currentSessionId: 'session-123',
      lastKilledSessionId: 'session-122',
      skills: ['secret-skill'],
      permissionMode: 'bypassPermissions',
      worktreePath: '/home/tars/wt',
      secondaryProjectPath: '/home/tars/other',
      orchestratorId: 'boss',
    }))!;
    for (const key of Object.keys(shared)) expect(SHARED_FIELDS as readonly string[]).toContain(key);
    const text = JSON.stringify(shared);
    for (const secret of ['sk-secret', MASTER, 'tok-agent', '/usr/local/bin/claude', 'session-123', 'session-122', 'secret-skill', 'bypassPermissions', '/home/tars/wt', '/home/tars/other', 'boss']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps what a desktop shows', () => {
    expect(shareAgent(agent({ branchName: 'feat/x', currentTask: 'Review', cliRunning: true, cols: 120, rows: 40 }))).toEqual({
      agentId: 'agent-1', name: 'Nova', status: 'running', provider: 'claude', model: 'opus', branch: 'feat/x',
      currentTask: 'Review', projectName: 'allcazz', projectPath: '/home/tars/tars-projects/allcazz', cliRunning: true, cols: 120, rows: 40,
    });
  });

  it('bounds every string', () => {
    const shared = shareAgent(agent({ name: 'n'.repeat(500), currentTask: 't'.repeat(5000), projectPath: `/${'p'.repeat(5000)}` }))!;
    expect(shared.name).toHaveLength(80);
    expect(shared.currentTask).toHaveLength(500);
    expect(shared.projectPath).toHaveLength(400);
  });

  it('drops control and format characters', () => {
    const shared = shareAgent(agent({ name: 'No\u001b[31mva\u202Etxt.exe', currentTask: 'line one\u0007\u200B' }))!;
    expect(shared.name).toBe('No[31mvatxt.exe');
    expect(shared.currentTask).toBe('line one');
  });

  it('shares no agent whose id cannot sit in a URL path', () => {
    expect(shareAgent(agent({ id: '../api/agents' }))).toBeNull();
    expect(shareAgent(agent({ id: 'a b' }))).toBeNull();
    expect(shareAgent(agent({ id: '' }))).toBeNull();
  });

  it('gives a size only for two whole numbers from 1 to 1000', () => {
    expect(shareAgent(agent({ cols: 0, rows: 40 }))).not.toHaveProperty('cols');
    expect(shareAgent(agent({ cols: 80, rows: 1001 }))).not.toHaveProperty('rows');
    expect(shareAgent(agent({ cols: 80.5, rows: 40 }))).not.toHaveProperty('cols');
  });
});

describe('shareFleet', () => {
  it(`shares ${MAX_SHARED_AGENTS} agents at most`, () => {
    const many = Array.from({ length: MAX_SHARED_AGENTS + 5 }, (_, i) => agent({ id: `a${i}` }));
    expect(shareFleet(many)).toHaveLength(MAX_SHARED_AGENTS);
  });

  it('loses no agent to a bad record', () => {
    const bad = { get id(): string { throw new Error('broken'); } } as unknown as AgentStatus;
    expect(shareFleet([agent({ id: 'a1' }), bad, agent({ id: 'a2' })]).map(a => a.agentId)).toEqual(['a1', 'a2']);
  });
});
