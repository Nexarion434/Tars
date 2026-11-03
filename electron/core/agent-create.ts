import { v4 as uuidv4 } from 'uuid';
import { getAllProviders, getProvider, isValidProvider } from '../providers';
import { planModeRefusal } from '../providers/plan-mode';
import { cliPathProblem } from '../platform/cli-path';
import { skillsProblem } from '../utils/skill-name';
import { handedFolderProblem } from '../utils/handed-folder';
import { assignRole, requestedRole } from './agent-role';
import { orchestratorMoved } from './chat-identity';
import { restartForSettings } from './agent-restart';
import type { AgentStatus, AgentCharacter, AgentRole, AppSettings } from '../types';

/**
 * An agent's record, made the one way Tars makes it outside the window's
 * New agent: by POST /api/agents (the MCP's create_agent), and, for a Tars
 * server, by the door and the server's CLI
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 1). The checks
 * are the ones POST /api/agents made, moved here unchanged; who may create,
 * and in which project, stays the caller's to decide (the route's
 * resolveDriver and mayActIn).
 *
 * Only the record: it is saved and announced, and nothing is spawned. The
 * agent starts the way every agent does (initAgentPty, spawnAgentSession).
 */

export interface NewAgentFields {
  projectPath: string;
  name?: string;
  skills?: string[];
  character?: AgentCharacter;
  permissionMode?: AgentStatus['permissionMode'];
  secondaryProjectPath?: string;
  /** The Orchestrator toggle, or its old name: see requestedRole. */
  role?: AgentRole;
  orchestratorMode?: boolean;
  provider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cliPath?: string;
}

export interface AgentCreateContext {
  agents: Map<string, AgentStatus>;
  saveAgents(): void;
  appSettings(): AppSettings;
  /** Tells the windows the fleet changed (a server has none: a no-op there). */
  announce(agent: AgentStatus): void;
  /** The new agent's id; uuid v4 unless a test names one. */
  newId?: () => string;
}

export type AgentCreateResult = { ok: true; agent: AgentStatus } | { ok: false; status: 400 | 403; error: string };

/** A model's name as a command line takes it: what create_agent and update_agent accept. */
export const MODEL_NAME = /^[a-zA-Z0-9._:\/\[\]-]+$/;

/**
 * An API-key provider runs the claude binary with ANTHROPIC_BASE_URL and its
 * key rewritten. Without its key there is no ANTHROPIC_BASE_URL and the
 * session would silently run on the user's Anthropic account: refused, at a
 * launch and, since 2.0.2, at a creation through the API, with the same
 * sentence.
 */
export function missingKeyRefusal(provider: AgentStatus['provider'], providerEnvVars: Record<string, string>): string | null {
  const isAltProvider = getProvider(provider).binaryName === 'claude' && !!provider && provider !== 'claude' && provider !== 'local';
  return isAltProvider && !providerEnvVars.ANTHROPIC_BASE_URL
    ? `No API key configured for provider "${provider}". Add it (or an OpenRouter key) in Settings > AI Providers.`
    : null;
}

export function createAgentRecord(fields: NewAgentFields, ctx: AgentCreateContext): AgentCreateResult {
  const { projectPath, name, skills = [], character, permissionMode, secondaryProjectPath, provider, model, effort, cliPath } = fields;
  const refuse = (status: 400 | 403, error: string): AgentCreateResult => ({ ok: false, status, error });

  if (!projectPath) return refuse(400, 'projectPath is required');
  // The folder it is handed besides its project: never ~/.tars-private (the Audit's L1 on #480), as update_agent.
  if (secondaryProjectPath !== undefined && secondaryProjectPath !== null && secondaryProjectPath !== '') {
    const handed = typeof secondaryProjectPath === 'string'
      ? handedFolderProblem(secondaryProjectPath)
      : 'secondaryProjectPath is the path of a folder';
    if (handed) return refuse(400, handed);
  }
  if (provider !== undefined && !isValidProvider(provider)) {
    return refuse(400, `Unknown provider "${provider}". Providers: ${getAllProviders().map((p) => p.id).join(', ')}.`);
  }
  if (permissionMode !== undefined && !['plan', 'normal', 'auto', 'bypass'].includes(permissionMode)) {
    return refuse(400, 'Invalid permission mode: plan, normal, auto or bypass');
  }
  // Plan on a provider that has none would run as normal (the Audit's Low 2 on #407).
  const noPlan = planModeRefusal(provider, permissionMode);
  if (noPlan) return refuse(400, noPlan);
  if (cliPath !== undefined) {
    const why = cliPathProblem(cliPath);
    if (why) return refuse(400, why);
  }
  // Every task the agent is given opens with its skills (gate of #204).
  const skillsWrong = skillsProblem(skills);
  if (skillsWrong) return refuse(400, `Not created: ${skillsWrong}`);
  if (model !== undefined && !MODEL_NAME.test(model)) return refuse(400, 'Invalid model name');
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return refuse(400, 'Invalid effort level');
  let role: AgentRole;
  try {
    role = requestedRole(fields as { role?: unknown; orchestratorMode?: unknown }) ?? 'worker';
  } catch (err) {
    return refuse(400, err instanceof Error ? err.message : 'Invalid role');
  }
  // An orchestrator is made in the Agents page and nowhere else. Made here,
  // it took the role from the project's current one and restarted it on the
  // word of whoever held a token, with none of the confirmation JeanBrasse asked
  // for: the QA's gate of #123 measured a worker's own token making itself a
  // "Rogue" orchestrator of its project, and with allowCrossProject, in
  // bypass, of another one. Nothing asks for it legitimately: the MCP's
  // create_agent sends no role. Decided on 2026-09-23, for every caller.
  if (role === 'orchestrator') {
    return refuse(403, 'An orchestrator is made in the Agents page of Tars, not over the API. Create the agent as a worker; the user can make it the orchestrator there.');
  }

  // The name is typed before the task id in the line that says who a message
  // is from: one that carries a task id would read as Tars's own (the Audit's
  // gate of #351; core/task-requests.ts reads the envelope, this keeps the
  // line plain for whoever reads it).
  if (typeof name === 'string' && /,\s*task\s+t-/i.test(name)) {
    return refuse(400, 'An agent\'s name cannot contain ", task t-": Tars types the task id after the name in the line that says who a message is from.');
  }

  const id = (ctx.newId ?? uuidv4)();
  // Refused as its first launch would be: an API-key provider without its key.
  const keyRefusal = missingKeyRefusal(provider as AgentStatus['provider'], getProvider(provider as AgentStatus['provider']).getPtyEnvVars(id, projectPath, skills, ctx.appSettings()));
  if (keyRefusal) return refuse(400, keyRefusal);
  const resolvedName = name || `Agent ${id.slice(0, 6)}`;
  const agent: AgentStatus = {
    id,
    status: 'idle',
    projectPath,
    secondaryProjectPath,
    skills,
    output: [],
    lastActivity: new Date().toISOString(),
    character,
    name: resolvedName,
    permissionMode: permissionMode || 'auto',
    provider: provider as AgentStatus['provider'],
    model,
    effort,
    cliPath,
  };
  // The role asked for, never the name; an orchestrator takes the role from
  // its project's current one, whoever creates it (core/agent-role.ts).
  const demoted = assignRole(agent, role, ctx.agents.values());
  ctx.agents.set(id, agent);
  ctx.saveAgents();
  // An orchestrator made here: its project's Main follows it (core/chat-identity.ts).
  orchestratorMoved();
  for (const other of demoted) restartForSettings(other.id, ['orchestrator']);
  ctx.announce(agent);
  return { ok: true, agent };
}
