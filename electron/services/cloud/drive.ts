import type { MessageSender } from '../../core/pty-manager';
import type { ClientKind } from './types';

/**
 * Driving a Tars server's agent for a client (plan Task 7). Knows nothing of
 * HTTP: the door calls it once the client is admitted with `drive`, and a later
 * transport could too. It follows the window's own path (agent:input,
 * agent:resize, agent:start, agent:stop), not the API's guards for agents: a
 * desktop with `drive` is the user at another keyboard.
 *
 * What a client starts, stops or says carries its name: a stop is filed under
 * "<name> (machine)" or "<name> (outside agent)", a message goes in after
 * `Message from the machine "<name>": ` or `Message from the outside agent
 * "<name>": ` (core/pty-manager.ts senderLine). A start types no first prompt.
 *
 * An outside agent (Hermes) may start, stop and message; it never types keys
 * and never sets a size, whatever its scopes: those are a person at a
 * keyboard, and its ceiling says so.
 */

export type DriveRequest =
  | { action: 'keys'; agentId: string; data: string }
  | { action: 'size'; agentId: string; cols: number; rows: number }
  | { action: 'start'; agentId: string }
  | { action: 'stop'; agentId: string; reason: string }
  | { action: 'message'; agentId: string; text: string };

export interface DriveCaller { name: string; kind: ClientKind }

export type DriveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/** The server's agents and terminals, as the executor reaches them (server/main.ts gives the real ones). */
export interface DriveTarget {
  hasAgent(agentId: string): boolean;
  typeKeys(agentId: string, data: string): 'ok' | 'no-terminal';
  resize(agentId: string, cols: number, rows: number): 'ok' | 'no-terminal';
  start(agentId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  stop(agentId: string, by: string, reason: string): Promise<void>;
  message(agentId: string, text: string, sender: MessageSender): 'ok' | 'no-terminal' | 'not-running';
}

export const MAX_KEYS = 4096;
export const MAX_DRIVE_TEXT = 8000;
const MAX_REASON = 200;
const NO_SUCH_AGENT = 'No such agent on this Tars server.';

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;
/** What is left of a text once controls, format characters and spaces are gone: nothing means nothing was said. */
const said = (text: string) => text.replace(/[\p{Cc}\p{Cf}\s]/gu, '');

export async function executeDrive(request: DriveRequest, caller: DriveCaller, target: DriveTarget): Promise<DriveOutcome> {
  const outside = caller.kind === 'outside-agent';
  if (outside && (request.action === 'keys' || request.action === 'size')) {
    return { ok: false, status: 403, error: `${caller.name} is an outside agent: it types nothing into a terminal and sets no size.` };
  }
  if (!target.hasAgent(request.agentId)) return { ok: false, status: 404, error: NO_SUCH_AGENT };

  switch (request.action) {
    case 'keys': {
      if (typeof request.data !== 'string' || request.data.length === 0 || request.data.length > MAX_KEYS) {
        return { ok: false, status: 400, error: `Keys are 1 to ${MAX_KEYS} characters.` };
      }
      return target.typeKeys(request.agentId, request.data) === 'ok'
        ? { ok: true }
        : { ok: false, status: 409, error: 'This agent has no terminal running.' };
    }
    case 'size': {
      if (!isSize(request.cols) || !isSize(request.rows)) {
        return { ok: false, status: 400, error: 'A size is two whole numbers from 1 to 1000.' };
      }
      // Remembered even with no terminal, as agent:resize does: the next one is spawned at this size.
      target.resize(request.agentId, request.cols, request.rows);
      return { ok: true };
    }
    case 'start': {
      const started = await target.start(request.agentId);
      return started.ok ? { ok: true } : { ok: false, status: 409, error: started.error };
    }
    case 'stop': {
      const reason = typeof request.reason === 'string' ? request.reason.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
      if (said(reason).length === 0 || reason.length > MAX_REASON) {
        return { ok: false, status: 400, error: `A stop needs its reason, 1 to ${MAX_REASON} characters.` };
      }
      await target.stop(request.agentId, `${caller.name} (${outside ? 'outside agent' : 'machine'})`, reason);
      return { ok: true };
    }
    case 'message': {
      if (typeof request.text !== 'string' || said(request.text).length === 0 || request.text.length > MAX_DRIVE_TEXT) {
        return { ok: false, status: 400, error: `A message is 1 to ${MAX_DRIVE_TEXT} characters, and says something.` };
      }
      const sender: MessageSender = outside ? { kind: 'outside-agent', name: caller.name } : { kind: 'machine', name: caller.name };
      const typed = target.message(request.agentId, request.text, sender);
      if (typed === 'ok') return { ok: true };
      return { ok: false, status: 409, error: typed === 'no-terminal' ? 'This agent has no terminal running.' : 'This agent\'s CLI is not running.' };
    }
  }
  return { ok: false, status: 400, error: 'Unknown action.' };
}
