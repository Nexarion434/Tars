import { getProvider } from '../providers';
import type { AgentStatus } from '../types';

/**
 * Providers whose interactive session never leaves `running`.
 *
 * amp, grok, opencode and pi have no native hooks, so their status only
 * changes when the process exits (codex's turns are read from its session log
 * since 2.0.4, services/codex-sessions.ts): a queue that waits for them to be at rest
 * would never drain. Read from the provider's own hook configuration rather
 * than a list written out here, so a provider that gains hooks stops being an
 * exception on the day it gains them, not on the day someone remembers.
 *
 * Here in core, beside the one-task rule that reads it too (core/one-task.ts);
 * the room's bus reads it through services/bus-store.ts.
 */
export function hasEndOfTurn(agent: Pick<AgentStatus, 'provider'>): boolean {
  try {
    const hooks = getProvider(agent.provider).getHookConfig();
    // Or its turns reach Tars by another way: codex's session log (2.0.4).
    return hooks.supportsNativeHooks || hooks.turnsReported === true;
  } catch {
    return false;
  }
}
