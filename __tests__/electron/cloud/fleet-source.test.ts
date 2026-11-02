import { describe, it, expect } from 'vitest';
import { fleetAnswer } from '../../../electron/services/cloud/fleet-source';
import type { CloudClient } from '../../../electron/services/cloud/types';
import type { AgentStatus } from '../../../electron/types';

/**
 * The fleet a client with `see` is answered (plan Task 6).
 *
 * How it fails:
 * - cliRunning or the terminal's size taken from the stored record, which
 *   never holds them, rather than from the agent's terminal now
 * - youMay other than the client's own scopes
 * - a project listed twice, or one without an agent in it
 */

const client: CloudClient = { id: 'c_00000001', name: 'Mac', kind: 'desktop', scopes: ['see'], hash: 'x', createdAt: '2026-11-02T00:00:00.000Z' };
const server = { id: '0123456789abcdef', name: 'vps' };

function agent(id: string, projectPath: string, extra: Record<string, unknown> = {}): AgentStatus {
  return { id, name: id, status: 'running', projectPath, ...extra } as unknown as AgentStatus;
}

describe('fleetAnswer', () => {
  it('reads whether the CLI runs, and its size, from the terminal now', () => {
    const answer = fleetAnswer(client, server, [agent('a1', '/p/one', { cliRunning: false, cols: 10, rows: 10 })], () => ({ cliRunning: true, cols: 120, rows: 40 }));
    expect(answer.agents[0]).toMatchObject({ agentId: 'a1', cliRunning: true, cols: 120, rows: 40 });
  });

  it('says the CLI is not running when there is no terminal', () => {
    const answer = fleetAnswer(client, server, [agent('a1', '/p/one', { cliRunning: true })], () => ({ cliRunning: false }));
    expect(answer.agents[0].cliRunning).toBe(false);
    expect(answer.agents[0]).not.toHaveProperty('cols');
  });

  it('tells the client its own scopes, and each project once', () => {
    const answer = fleetAnswer(client, server, [agent('a1', '/p/one'), agent('a2', '/p/one'), agent('a3', '/p/two')], () => ({ cliRunning: false }));
    expect(answer.youMay).toEqual(['see']);
    expect(answer.projects).toEqual([{ name: 'one', path: '/p/one' }, { name: 'two', path: '/p/two' }]);
  });
});
