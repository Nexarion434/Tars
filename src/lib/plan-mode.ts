import type { AgentPermissionMode, TeamPermissionMode } from '@/types/agent';
import { PROVIDER_REGISTRY } from './providers';

/**
 * Where an agent's permission selectors offer plan (frames: `Permissions · plan
 * mode · states`). PR B (#364) launches claude with --permission-mode plan; the
 * other CLIs, the API-key providers among them, read plan as normal, the
 * narrowest they have. The main process launches an agent with no provider, or
 * with one it does not know, as claude.
 */
export function hasPlanMode(provider: string | null | undefined): boolean {
  if (!provider || provider === 'claude') return true;
  return !PROVIDER_REGISTRY.some(def => def.id === provider);
}

/** The mode an agent keeps when its provider changes: plan falls back to manual where it would not run. */
export function modeForProvider(mode: AgentPermissionMode, provider: string | null | undefined): AgentPermissionMode {
  return mode === 'plan' && !hasPlanMode(provider) ? 'normal' : mode;
}

/** What a dimmed plan says, as its title. */
export function noPlanReason(provider: string | null | undefined): string {
  const label = PROVIDER_REGISTRY.find(def => def.id === provider)?.label ?? provider ?? 'This CLI';
  return `${label} has no plan mode here: plan would run as manual.`;
}

/** The mode a template keeps, which has no plan: plan is saved as manual, the narrowest of the three. */
export function templateModeOf(mode: AgentPermissionMode): TeamPermissionMode {
  return mode === 'plan' ? 'normal' : mode;
}
