import { AsyncLocalStorage } from 'async_hooks';

/**
 * Who a request to the API came from, for the work it starts after it returns (2.0.4): a task delivered by an agent's
 * tool that never starts is that tool's error (core/agent-manager.ts armTaskStartWatch), and the watch that finds it
 * fires ten minutes after the request. Set by the API server around each route, read where the work is armed.
 */
export interface ApiCall {
  /** The tool the agent's MCP server named (`X-Tars-Tool`): checked where it is reported. */
  tool?: string;
  /** Sent by an MCP server Tars handed an agent (`X-Tars-Client: mcp`). */
  fromMcp: boolean;
  /** The agent the token named. */
  agentId?: string;
}

const calls = new AsyncLocalStorage<ApiCall>();

export function inApiCall<T>(call: ApiCall, run: () => T): T {
  return calls.run(call, run);
}

/** The request this code runs for, or undefined outside one (the window, a bot, a timer of its own). */
export function currentApiCall(): ApiCall | undefined {
  return calls.getStore();
}
