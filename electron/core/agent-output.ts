/**
 * Who hears an agent terminal's output besides the windows: a Tars server's
 * door, which streams it to its clients (services/cloud/door.ts). Fed by
 * attachAgentTerminal (agent-manager.ts) where it broadcasts `agent:output`.
 * The desktop registers no listener, so its terminals behave as before. A
 * listener that throws is logged and kept from the others and from the
 * terminal.
 */
export type AgentOutputListener = (agentId: string, chunk: string) => void;

const listeners = new Set<AgentOutputListener>();

export function onAgentOutput(listener: AgentOutputListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitAgentOutput(agentId: string, chunk: string): void {
  for (const listener of listeners) {
    try {
      listener(agentId, chunk);
    } catch (err) {
      console.error('[agent-output] a listener failed:', err);
    }
  }
}
