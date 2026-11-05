import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));

import { createAgentRecord, type AgentCreateContext } from '../../../electron/core/agent-create';
import { PRIVATE_DIR } from '../../../electron/constants';
import type { AgentStatus, AppSettings } from '../../../electron/types';

/**
 * One function creates an agent's record (core/agent-create.ts), the one
 * POST /api/agents calls, and the door and the server's CLI will
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 1).
 *
 * How it fails, written before the code:
 * 1. a refusal the route made is lost on the way, or comes back with another
 *    status or sentence: no project, a secondary folder in ~/.tars-private,
 *    an unknown provider, a permission mode Tars has not got, plan on a
 *    provider without it, a bad CLI path, a skill that is not a skill name
 *    (utils/skill-name.ts), a model or effort
 *    outside the grammar, an orchestrator (403), a name carrying ", task t-",
 *    an API-key provider without its key
 * 2. a refusal leaves something behind: a record in the fleet, a save
 * 3. the record differs from the route's: another field, another default
 *    (permission mode auto, role worker, status idle, no output)
 * 4. creating spawns anything: a terminal, a worktree (no ptyId, no
 *    worktreePath on the record)
 * 5. a record made is not saved once and announced once
 * 6. (Tars cloud, "l'orchestrateur en cloud", 2026-11-04) an orchestrator made
 *    without the caller's explicit leave (`orchestratorAllowed`, given by a
 *    Tars server's door only), or, with it, not the project's only one
 */

const project = path.join(os.tmpdir(), 'tars-agent-create-project');
const context = (settings: Partial<AppSettings> = {}) => {
  const agents = new Map<string, AgentStatus>();
  const saveAgents = vi.fn();
  const announce = vi.fn();
  const ctx: AgentCreateContext = { agents, saveAgents, appSettings: () => settings as AppSettings, announce, newId: () => 'a-new-id' };
  return { ctx, agents, saveAgents, announce };
};

describe('createAgentRecord, an orchestrator with the door\'s leave (6)', () => {
  it('6. made as its project\'s orchestrator only with the leave, the one it had becoming a worker', () => {
    const { ctx, agents } = context();
    agents.set('old', { id: 'old', projectPath: project, role: 'orchestrator', orchestratorMode: true, status: 'idle' } as AgentStatus);
    agents.set('elsewhere', { id: 'elsewhere', projectPath: `${project}-2`, role: 'orchestrator', orchestratorMode: true, status: 'idle' } as AgentStatus);
    expect(createAgentRecord({ projectPath: project, role: 'orchestrator' }, ctx)).toMatchObject({ ok: false, status: 403 });
    expect(createAgentRecord({ projectPath: project, role: 'orchestrator' }, { ...ctx, orchestratorAllowed: true })).toMatchObject({ ok: true, agent: { role: 'orchestrator' } });
    expect(agents.get('old')?.role).toBe('worker');
    expect(agents.get('elsewhere')?.role).toBe('orchestrator');
  });
});

describe('createAgentRecord', () => {
  it.each([
    ['no project', { projectPath: '' }, 400, 'projectPath is required'],
    ['a secondary folder in the private one', { secondaryProjectPath: PRIVATE_DIR }, 400, undefined],
    ['an unknown provider', { provider: 'nobody' }, 400, /^Unknown provider "nobody"/],
    ['an unknown permission mode', { permissionMode: 'yolo' }, 400, 'Invalid permission mode: plan, normal, auto or bypass'],
    ['plan on a provider without it', { provider: 'gemini', permissionMode: 'plan' }, 400, undefined],
    ['a relative cli path', { cliPath: 'bin/claude' }, 400, undefined],
    ['a skill with a space', { skills: ['a b'] }, 400, /^Not created: /],
    ['a model outside the grammar', { model: 'opus; rm -rf' }, 400, 'Invalid model name'],
    ['an effort Tars has not got', { effort: 'huge' }, 400, 'Invalid effort level'],
    ['an orchestrator', { role: 'orchestrator' }, 403, /^An orchestrator is made in the Agents page/],
    ['a name carrying a task id', { name: 'Nova, task t-1a2b3c4d' }, 400, /cannot contain ", task t-"/],
    ['an API-key provider without its key', { provider: 'deepseek' }, 400, /^No API key configured for provider "deepseek"/],
  ])('1, 2. refuses %s, and leaves nothing behind', (_what, over, status, error) => {
    const t = context();
    const answer = createAgentRecord({ projectPath: project, ...over } as never, t.ctx);
    expect(answer).toMatchObject({ ok: false, status });
    if (typeof error === 'string') expect((answer as { error: string }).error).toBe(error);
    else if (error) expect((answer as { error: string }).error).toMatch(error);
    expect(t.agents.size).toBe(0);
    expect(t.saveAgents).not.toHaveBeenCalled();
    expect(t.announce).not.toHaveBeenCalled();
  });

  it('3, 4, 5. makes the route\'s record, spawns nothing, saves and announces it once', () => {
    const t = context();
    const answer = createAgentRecord({ projectPath: project, name: 'Test cloud', provider: 'claude', model: 'haiku', skills: [] }, t.ctx);
    expect(answer.ok).toBe(true);
    const agent = (answer as { agent: AgentStatus }).agent;
    expect(agent).toMatchObject({
      id: 'a-new-id', status: 'idle', projectPath: project, skills: [], output: [], name: 'Test cloud',
      permissionMode: 'auto', provider: 'claude', model: 'haiku', role: 'worker',
    });
    expect(agent.ptyId).toBeUndefined();
    expect(agent.worktreePath).toBeUndefined();
    expect(t.agents.get('a-new-id')).toBe(agent);
    expect(t.saveAgents).toHaveBeenCalledTimes(1);
    expect(t.announce).toHaveBeenCalledTimes(1);
  });

  it('3. a name left out is "Agent <first six of the id>"', () => {
    const t = context();
    const answer = createAgentRecord({ projectPath: project }, t.ctx);
    expect((answer as { agent: AgentStatus }).agent.name).toBe('Agent a-new-');
  });
});
