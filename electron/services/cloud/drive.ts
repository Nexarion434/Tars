import type { ClientKind } from './types';

/**
 * Driving a Tars server's agent for a client (plan Task 7). Knows nothing of
 * HTTP: the door calls it once the client is admitted with `drive`, and a later
 * transport could too. It follows the window's own path, not the API's guards
 * for agents: a desktop with `drive` is the user at another keyboard.
 *
 * First half: keys (agent:input, writeHumanInput) and size (agent:resize).
 * Start, stop with a reason and message, which sign what they do with the
 * client's name (a sender line), come in the second half.
 *
 * An outside agent (Hermes) never types keys and never sets a size, whatever
 * its scopes: those are a person at a keyboard, and its ceiling says so.
 */

export type DriveRequest =
  | { action: 'keys'; agentId: string; data: string }
  | { action: 'size'; agentId: string; cols: number; rows: number };

export interface DriveCaller { name: string; kind: ClientKind }

export type DriveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/** The server's terminals, as the executor reaches them (server/main.ts gives the real ones). */
export interface DriveTarget {
  hasAgent(agentId: string): boolean;
  typeKeys(agentId: string, data: string): 'ok' | 'no-terminal';
  resize(agentId: string, cols: number, rows: number): 'ok' | 'no-terminal';
}

export const MAX_KEYS = 4096;
const NO_SUCH_AGENT = 'No such agent on this Tars server.';

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;

export function executeDrive(request: DriveRequest, caller: DriveCaller, target: DriveTarget): DriveOutcome {
  if (caller.kind === 'outside-agent') {
    return { ok: false, status: 403, error: `${caller.name} is an outside agent: it types nothing into a terminal and sets no size.` };
  }
  if (!target.hasAgent(request.agentId)) return { ok: false, status: 404, error: NO_SUCH_AGENT };
  if (request.action === 'keys') {
    if (typeof request.data !== 'string' || request.data.length === 0 || request.data.length > MAX_KEYS) {
      return { ok: false, status: 400, error: `Keys are 1 to ${MAX_KEYS} characters.` };
    }
    return target.typeKeys(request.agentId, request.data) === 'ok'
      ? { ok: true }
      : { ok: false, status: 409, error: 'This agent has no terminal running.' };
  }
  if (!isSize(request.cols) || !isSize(request.rows)) {
    return { ok: false, status: 400, error: 'A size is two whole numbers from 1 to 1000.' };
  }
  // Remembered even with no terminal, as agent:resize does: the next one is spawned at this size.
  target.resize(request.agentId, request.cols, request.rows);
  return { ok: true };
}
