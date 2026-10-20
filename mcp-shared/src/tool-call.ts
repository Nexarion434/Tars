/**
 * The tool a server is running, from registerTools (tools.ts) to the calls it makes to Tars (tars-api.ts), which
 * name it in `X-Tars-Tool`: Tars reports an agent's tool error with the tool it came from (2.0.4). Node's own
 * AsyncLocalStorage, so two tools running at once each keep their own name.
 */

import { AsyncLocalStorage } from "async_hooks";

export const toolCall = new AsyncLocalStorage<string>();
