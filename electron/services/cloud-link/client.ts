import * as http from 'http';
import type { LocalForwardEnd } from '../../platform/local-forward';
import type { HelloResult, LinkClient } from './link';

/**
 * The server's door through the desktop's forward (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md,
 * Tasks 5 and 7): a Unix socket end by its path, a loopback end by its port,
 * always `Host: localhost` (the door refuses any other). `hello` is the one
 * request sent without the credential: the link asks it first and hands the
 * credential on only when the door names the expected server.
 *
 * Adapted from `win/machines`' electron/services/machines/client.ts: every
 * call settles within its timeout, as status 0 when no whole answer came (the
 * link broke, which the link retries), and a refusal the door answered (401,
 * 403, 404, 413) is that status, which it does not.
 */

/** What the door answered; status 0 when no whole answer came. */
export interface DoorAnswer { status: number; body: Record<string, unknown> }
export type DriveAction = 'keys' | 'size' | 'start' | 'stop' | 'message';
/**
 * Why a stream ended: the door ended it (`revoked`, or `ended` for any other
 * reason it gives), refused it at its head (with the status), it dropped,
 * went silent past its idle time (the door says something every 15 s), sent
 * something that is not a terminal's output, or this side closed it.
 */
export type StreamEnd =
  | { reason: 'revoked' | 'ended' | 'dropped' | 'silent' | 'malformed' | 'closed' }
  | { reason: 'refused'; status: number };

export interface DoorClient extends LinkClient {
  fleet(): Promise<DoorAnswer>;
  screen(agentId: string): Promise<DoorAnswer>;
  drive(agentId: string, action: DriveAction, body: Record<string, unknown>): Promise<DoorAnswer>;
  /** One agent's live output: onOpen once the door answered 200, each chunk in order, then onEnd once, and nothing after it. */
  stream(agentId: string, onChunk: (chunk: string) => void, onEnd: (how: StreamEnd) => void, opts?: { idleMs?: number; onOpen?: () => void }): { close(): void };
}

const HELLO_MAX = 64 * 1024;
/** What any answer of the door may weigh: a fleet, or a screen with its scrollback. */
const ANSWER_MAX = 4 * 1024 * 1024;
/** The door reads 64 KB of a body at most (door.ts MAX_BODY). */
const BODY_MAX = 64 * 1024;
const TIMEOUT_MS = 10_000;
/** A start waits for its CLI to launch on the server. */
const START_TIMEOUT_MS = 30_000;
const SERVER_ID = /^[0-9a-f]{16}$/;
const STREAM_IDLE_MS = 45_000;
/** What a stream may hold unparsed: more than one event this large is not a terminal's output. */
const EVENT_MAX = 1024 * 1024;

function target(end: LocalForwardEnd): http.RequestOptions {
  return end.kind === 'unix' ? { socketPath: end.path } : { host: '127.0.0.1', port: end.port };
}

function request(end: LocalForwardEnd, method: string, urlPath: string, opts: { credential?: string; body?: unknown; timeoutMs?: number; maxBytes?: number } = {}): Promise<DoorAnswer> {
  return new Promise(resolve => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    let req: http.ClientRequest | undefined;
    let settled = false;
    let head = 0;
    const settle = (status: number, body: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (status === 0) req?.destroy();
      resolve({ status, body });
    };
    // Dropped before a whole answer: a refusal already in its head is still that refusal.
    const cut = () => settle(head >= 400 ? head : 0);
    const deadline = setTimeout(() => settle(0), opts.timeoutMs ?? TIMEOUT_MS);
    try {
      req = http.request({
        ...target(end),
        method,
        path: urlPath,
        headers: {
          Host: 'localhost',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(opts.credential ? { Authorization: `Bearer ${opts.credential}` } : {}),
        },
      }, res => {
        head = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (opts.maxBytes ?? ANSWER_MAX)) return settle(0);
          chunks.push(chunk);
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
          } catch { /* not json */ }
          settle(head, body);
        });
        res.on('aborted', cut);
        res.on('error', cut);
        res.on('close', cut);
      });
    } catch { settle(0); return; }
    req.on('error', cut);
    if (data) req.write(data);
    req.end();
  });
}

const agentPath = (agentId: string, route: string) => `/cloud/v1/agents/${encodeURIComponent(agentId)}/${route}`;

/** The door's `event: end` names its reason on its data line (door.ts openStream). */
function endReason(event: string): StreamEnd {
  const line = event.split('\n').find(l => l.startsWith('data: '));
  let reason: unknown;
  try { reason = line ? JSON.parse(line.slice('data: '.length)) : undefined; } catch { /* no reason */ }
  return { reason: reason === 'revoked' ? 'revoked' : 'ended' };
}

/** Server-sent events from the door's stream route, adapted from win/machines' openStream. */
function openStream(end: LocalForwardEnd, credential: string | undefined, agentId: string, onChunk: (chunk: string) => void, onEnd: (how: StreamEnd) => void, idleMs: number, onOpen?: () => void): { close(): void } {
  let ended = false;
  let req: http.ClientRequest | undefined;
  const finish = (how: StreamEnd) => {
    if (ended) return;
    ended = true;
    req?.destroy();
    onEnd(how);
  };
  const dropped = () => finish({ reason: 'dropped' });
  try {
    req = http.request({
      ...target(end),
      method: 'GET',
      path: agentPath(agentId, 'stream'),
      headers: { Host: 'localhost', Accept: 'text/event-stream', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish({ reason: 'refused', status: res.statusCode ?? 0 });
      }
      onOpen?.();
      res.setEncoding('utf8');
      let pending = '';
      res.on('data', (text: string) => {
        if (ended) return;
        pending += text;
        let at: number;
        while ((at = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, at);
          pending = pending.slice(at + 2);
          // A comment (": open", ": keepalive") keeps the line open and carries nothing.
          if (event.startsWith(':')) continue;
          if (event.startsWith('event: end\n')) return finish(endReason(event));
          let chunk: unknown;
          try { chunk = event.startsWith('data: ') ? JSON.parse(event.slice('data: '.length)) : undefined; } catch { /* malformed */ }
          if (typeof chunk !== 'string') return finish({ reason: 'malformed' });
          onChunk(chunk);
          if (ended) return;
        }
        if (pending.length > EVENT_MAX) finish({ reason: 'malformed' });
      });
      res.on('end', dropped);
      res.on('close', dropped);
      res.on('error', dropped);
    });
  } catch {
    dropped();
    return { close: () => {} };
  }
  req.on('error', dropped);
  req.setTimeout(idleMs, () => finish({ reason: 'silent' }));
  req.end();
  return { close: () => finish({ reason: 'closed' }) };
}

export function createDoorClient(end: LocalForwardEnd, credential?: string): DoorClient {
  return {
    async hello(): Promise<HelloResult> {
      const answer = await request(end, 'GET', '/cloud/v1/hello', { maxBytes: HELLO_MAX });
      if (answer.status === 0) return { ok: false, detail: 'The door did not answer.' };
      const serverId = answer.body.serverId;
      if (answer.status !== 200 || typeof serverId !== 'string' || !SERVER_ID.test(serverId)) {
        return { ok: false, status: answer.status, detail: `The door answered ${answer.status} to hello.` };
      }
      return { ok: true, serverId };
    },
    fleet: () => request(end, 'GET', '/cloud/v1/fleet', { credential }),
    screen: agentId => request(end, 'GET', agentPath(agentId, 'screen'), { credential }),
    async drive(agentId, action, body) {
      if (Buffer.byteLength(JSON.stringify(body)) > BODY_MAX) {
        return { status: 413, body: { error: `A request carries ${BODY_MAX / 1024} KB at most: this one was not sent.` } };
      }
      return request(end, 'POST', agentPath(agentId, action), { credential, body, timeoutMs: action === 'start' ? START_TIMEOUT_MS : TIMEOUT_MS });
    },
    stream: (agentId, onChunk, onEnd, opts = {}) => openStream(end, credential, agentId, onChunk, onEnd, opts.idleMs ?? STREAM_IDLE_MS, opts.onOpen),
  };
}
