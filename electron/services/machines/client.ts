import * as http from 'http';
import { readMachines, writeMachines, newSecret, hashSecret, cleanName, isSecret } from './store';
import { codeProof, answerMatches, newCallerNonce } from './pairing';
import { MACHINES_PORT_DEFAULT, PAIR_WAIT_MS } from './bridge-server';
import type { PairedMachine } from './types';

/**
 * This Tars calling another one's bridge (bridge-server.ts): to pair with
 * the code it shows, to ask whether it is there, and to tell it this
 * machine forgets it.
 */
export interface Candidate { host: string; port: number }
export type PairResult = { ok: true; name: string } | { ok: false; error: string };
export type PingResult = { status: 'connected'; agentsRunning: number } | { status: 'offline' } | { status: 'unpaired' };

/** The most an answer may weigh: every answer of the bridge is a few hundred bytes. */
const MAX_ANSWER = 64 * 1024;

/**
 * One call to another bridge. It always settles, within timeoutMs from the
 * start whatever the other side does (headers then nothing, a connection
 * dropped mid-answer, an answer that never ends), as status 0 when no whole
 * answer came: a call that hung would hold the status poll with it.
 */
function request(c: Candidate, method: string, path: string, opts: { secret?: string; body?: unknown; timeoutMs: number; maxBytes?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    let req: http.ClientRequest | undefined;
    let settled = false;
    const settle = (status: number, body: Record<string, unknown> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (status === 0) req?.destroy();
      resolve({ status, body });
    };
    const deadline = setTimeout(() => settle(0), opts.timeoutMs);
    // A header Node refuses (a stored secret with a line break) throws here: no answer, never a throw.
    try {
      req = http.request({
        host: c.host,
        port: c.port,
        path,
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {}),
        },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (opts.maxBytes ?? MAX_ANSWER)) return settle(0);
          chunks.push(chunk);
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
          } catch { /* not json */ }
          settle(res.statusCode ?? 0, body);
        });
        // Dropped before its end: after a whole answer, settle has already run.
        res.on('aborted', () => settle(0));
        res.on('error', () => settle(0));
        res.on('close', () => settle(0));
      });
    } catch { settle(0); return; }
    req.on('error', () => settle(0));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Where a pairing code may be shown: every online machine of the tailnet, on
 * the bridge's port. A development run may name them instead
 * (TARS_MACHINES_PEERS="127.0.0.1:31484,..."), as the e2e suite does; a
 * packaged Tars never reads it.
 */
export function candidatesFrom(env: NodeJS.ProcessEnv, packaged: boolean, peers: { ip: string; online: boolean; shared?: boolean }[]): Candidate[] {
  if (!packaged && env.TARS_MACHINES_PEERS) {
    return env.TARS_MACHINES_PEERS.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [host, port] = s.split(':');
      return { host, port: Number(port) || MACHINES_PORT_DEFAULT };
    });
  }
  return peers.filter(p => p.online && !p.shared).map(p => ({ host: p.ip, port: MACHINES_PORT_DEFAULT }));
}

/**
 * Pairs with the first candidate showing a code, proving the code over its
 * nonce; the code itself never leaves. Only a machine that proves the code
 * back is stored, under the id it said hello with, its name and secret as
 * pairing makes them: any other machine of the tailnet can answer hello.
 */
export async function pairWithCode(typed: string, candidates: Candidate[], myPort: number): Promise<PairResult> {
  const code = typed.replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, error: 'A pairing code is six digits.' };
  const file = readMachines();
  for (const c of candidates) {
    const hello = await request(c, 'GET', '/machines/v1/hello', { timeoutMs: 2_000 });
    const theirId = hello.body.id;
    if (hello.status !== 200 || typeof hello.body.nonce !== 'string' || typeof theirId !== 'string' || !/^m-[0-9a-f]{16}$/.test(theirId)) continue;
    const nonce = hello.body.nonce;
    // Asks first, with no proof: the person at the other machine sees who
    // asks, then clicks, which takes its whole wait at most.
    const knock = await request(c, 'POST', '/machines/v1/knock', {
      timeoutMs: PAIR_WAIT_MS + 15_000,
      body: { id: file.self.id, name: file.self.name, nonce },
    });
    if (knock.status !== 200) {
      return { ok: false, error: typeof knock.body.error === 'string' ? knock.body.error : 'The other machine did not accept this one.' };
    }
    // Then the proof, answered within five seconds: a machine that accepted in
    // the other one's place cannot try the codes against it in that time.
    // A nonce of this machine's own, fresh each time, in the key: no key can be worked out before the proof is sent.
    const callerNonce = newCallerNonce();
    const mine = newSecret();
    const answer = await request(c, 'POST', '/machines/v1/pair', {
      timeoutMs: 5_000,
      body: { id: file.self.id, name: file.self.name, port: myPort, callerNonce, proof: codeProof(code, nonce, callerNonce, file.self.id), secret: mine },
    });
    if (answer.status !== 200) {
      return { ok: false, error: typeof answer.body.error === 'string' ? answer.body.error : 'The other machine refused the code.' };
    }
    const unlike: PairResult = { ok: false, error: 'That machine answered with something pairing does not make. Nothing was paired.' };
    // The id hello gave, and never this machine's own (the other side refuses that first, with its sentence).
    if (answer.body.id !== theirId || theirId === file.self.id) return unlike;
    if (!answerMatches(answer.body.proof, code, nonce, callerNonce, file.self.id, theirId)) {
      return { ok: false, error: 'That machine did not prove it knows the code. Nothing was paired.' };
    }
    let name: string;
    try { name = cleanName(answer.body.name); } catch { return unlike; }
    const secret = answer.body.secret;
    if (!isSecret(secret)) return unlike;
    const id = theirId;
    const latest = readMachines();
    writeMachines({
      ...latest,
      peers: [...latest.peers.filter(p => p.id !== id), {
        id, name, address: c.host, port: c.port,
        inboundSecretHash: hashSecret(mine), outboundSecret: secret,
        mayOnMe: 'see', pairedAt: new Date().toISOString(),
      }],
    });
    return { ok: true, name };
  }
  return { ok: false, error: 'No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first. If it shows one, your Tailscale access rules may keep the two apart: they must let them reach each other on port 31418.' };
}

/** Whether a paired machine is there: 401 means it forgot this one, which is not the same as offline. */
export async function ping(peer: PairedMachine): Promise<PingResult> {
  const r = await request({ host: peer.address, port: peer.port }, 'GET', '/machines/v1/ping', { secret: peer.outboundSecret, timeoutMs: 3_000 });
  if (r.status === 200) return { status: 'connected', agentsRunning: Number(r.body.agentsRunning) || 0 };
  if (r.status === 401) return { status: 'unpaired' };
  return { status: 'offline' };
}

/** What a fleet answer may weigh: MAX_SHARED_AGENTS agents of a few hundred bytes each. */
const MAX_FLEET = 512 * 1024;
/** What a screen may weigh: 2,500 lines of scrollback with their colours. */
const MAX_SCREEN = 8 * 1024 * 1024;

/** A paired machine's fleet answer (fleet-share reads it), or the status that came instead: 0 for none, 401 when it forgot this one. */
export async function fetchFleet(peer: PairedMachine): Promise<{ status: number; body: Record<string, unknown> }> {
  return request({ host: peer.address, port: peer.port }, 'GET', '/machines/v1/fleet', { secret: peer.outboundSecret, timeoutMs: 5_000, maxBytes: MAX_FLEET });
}

/** One remote agent's terminal as it is now, or null when its machine does not give one. */
export async function fetchScreen(peer: PairedMachine, agentId: string): Promise<{ screen: string; cliRunning: boolean } | null> {
  const r = await request({ host: peer.address, port: peer.port }, 'GET', `/machines/v1/agents/${encodeURIComponent(agentId)}/screen`, { secret: peer.outboundSecret, timeoutMs: 10_000, maxBytes: MAX_SCREEN });
  return r.status === 200 && typeof r.body.screen === 'string' ? { screen: r.body.screen, cliRunning: r.body.cliRunning === true } : null;
}

/** What a stream may hold unparsed: more than one event this large is not a terminal's output. */
const MAX_EVENT = 1024 * 1024;

/**
 * One remote agent's live output (bridge-server, streamOutput): each chunk
 * to onChunk, in order, then onEnd once, whether the other side ended it, the
 * connection dropped or went silent past idleMs (the bridge pings every
 * fifteen seconds), an event came malformed or too large, or close() was
 * called. Nothing after onEnd.
 */
export function openStream(peer: PairedMachine, agentId: string, onChunk: (chunk: string) => void, onEnd: () => void, opts: { idleMs?: number } = {}): { close: () => void } {
  let ended = false;
  let req: http.ClientRequest | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    req?.destroy();
    onEnd();
  };
  try {
    req = http.request({
      host: peer.address, port: peer.port, method: 'GET',
      path: `/machines/v1/agents/${encodeURIComponent(agentId)}/stream`,
      headers: { Authorization: `Bearer ${peer.outboundSecret}`, Accept: 'text/event-stream' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return end(); }
      res.setEncoding('utf8');
      let pending = '';
      res.on('data', (text: string) => {
        if (ended) return;
        pending += text;
        let at: number;
        while ((at = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, at);
          pending = pending.slice(at + 2);
          // A comment (": ping") keeps the line open and carries nothing.
          if (event.startsWith(':')) continue;
          let chunk: unknown;
          try { chunk = event.startsWith('data: ') ? JSON.parse(event.slice('data: '.length)) : undefined; } catch { /* malformed */ }
          if (typeof chunk !== 'string') return end();
          onChunk(chunk);
          if (ended) return;
        }
        if (pending.length > MAX_EVENT) end();
      });
      res.on('end', end);
      res.on('close', end);
      res.on('error', end);
    });
  } catch { end(); return { close: end }; }
  req.on('error', end);
  req.setTimeout(opts.idleMs ?? 45_000, end);
  req.end();
  return { close: end };
}

/**
 * Forgets the machine here first, then tells it (best effort: it may be off,
 * or never answer). Its secret no longer opens this bridge either way, and a
 * machine that was not told finds out at its next ping (401).
 */
export async function unpairPeer(peerId: string): Promise<void> {
  const latest = readMachines();
  const peer = latest.peers.find(p => p.id === peerId);
  if (!peer) return;
  writeMachines({ ...latest, peers: latest.peers.filter(p => p.id !== peerId) });
  await request({ host: peer.address, port: peer.port }, 'POST', '/machines/v1/unpair', { secret: peer.outboundSecret, body: {}, timeoutMs: 3_000 });
}
