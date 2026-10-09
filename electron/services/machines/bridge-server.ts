import * as http from 'http';
import { app } from 'electron';
import { readMachines, writeMachines, newSecret, hashSecret, secretMatches, cleanName, isSecret } from './store';
import { Offer, openOffer, checkProof, answerProof, isNonce } from './pairing';
import { detectTailscale, tailnetIp } from '../tailscale-status';
import type { PairedMachine, RemoteScreen } from './types';
import { terminalSize, type SharedAgent } from './fleet-share';

/**
 * The machines bridge: how another Tars of the same tailnet reaches this one.
 *
 * A server of its own, apart from the loopback API (api-server.ts), which
 * never leaves 127.0.0.1 and whose token, pass and webhook secret are not
 * accepted here. It listens on this machine's Tailscale IPv4 only, never on
 * 0.0.0.0, and not at all without one. Eight routes, listed below and nothing
 * else: an unknown path is 404 before any credential is read. A caller is a
 * paired machine when it presents the secret this Tars issued to it at
 * pairing (kept here as a hash). SECURITY.md, "The machines bridge".
 */
/**
 * Fixed, since the other machine has to know it without asking: not the
 * API's 31415, nor 31416, which the OpenAI bridge takes (OPENAI_BRIDGE_PORT,
 * the API's port + 1).
 */
export const MACHINES_PORT_DEFAULT = 31418;
const MAX_BODY = 64 * 1024;

export interface BridgeDeps {
  /** Agents running on this machine, for ping. */
  runningAgents: () => number;
  /** Told after a pairing or an unpairing changed the file. */
  onChanged: () => void;
  /** Told when a machine starts asking to pair, and when it stops (accepted, refused, gone, out of time). */
  onRequestChanged?: () => void;
  /** The MagicDNS name of the device at an address, which the tailnet keeps unique (tailscale-status, deviceName). */
  deviceAt?: (address: string) => Promise<string | undefined>;
  /** How long a request waits for the person here (PAIR_WAIT_MS); a test shortens it. */
  pairWaitMs?: number;
  /** This machine's agents as a paired machine sees them (fleet-share.ts). */
  fleet?: () => SharedAgent[];
  /** One agent's terminal as it is now, or null when it has none. */
  screenOf?: (agentId: string) => RemoteScreen | null;
  /**
   * Listens to one agent's terminal output until the returned function is
   * called; onEnd when the terminal ends. Null when the agent has none.
   */
  onOutput?: (agentId: string, listener: (chunk: string) => void, onEnd: () => void) => (() => void) | null;
  /** How often a live output pings and reads its machine's pairing again (fifteen seconds); a test shortens it. */
  streamCheckMs?: number;
  /** This machine's side of driving an agent (fleet-source.ts), for a machine this one lets drive. by: the name it was paired under. */
  drive?: {
    start: (agentId: string, by: string, prompt?: string) => Promise<DriveOutcome>;
    stop: (agentId: string, by: string, reason: string) => Promise<DriveOutcome>;
    message: (agentId: string, by: string, text: string) => Promise<DriveOutcome>;
  };
  now?: () => number;
}

/** A machine that knocked, with no proof yet, and waits for the person at this one to accept it. */
export interface PairRequest { name: string; device?: string; address: string; expiresAt: number }

/** How long a machine that knocked waits for the person here to answer, the code's own end permitting. */
export const PAIR_WAIT_MS = 60_000;
export interface BindTarget { host: string; port: number }

let server: http.Server | null = null;
/** A start under way: a second call waits for it rather than opening a second server on the port. */
let starting: Promise<{ listening: boolean; reason?: string; target?: BindTarget }> | null = null;
let state: { listening: boolean; reason?: string; target?: BindTarget } = { listening: false };
let offer: Offer | null = null;
let activeDeps: BridgeDeps | null = null;

const isIpv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s) && s !== '0.0.0.0';

/**
 * 100.64.0.0/10, the range Tailscale draws every machine's IPv4 from, as a
 * socket may report it (::ffff:100.x). Bound to the tailnet address, the
 * bridge still answers only callers from it: macOS also hands that socket
 * what arrives over the LAN for the address.
 */
export function isTailnetAddress(address: string | undefined): boolean {
  const m = /^(?:::ffff:)?100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address ?? '');
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255;
}

/** Whether a development run names where to listen; a packaged Tars never does. */
const usesDevOverride = (env: NodeJS.ProcessEnv, packaged: boolean) => !packaged && env.TARS_MACHINES_BIND !== undefined;

/**
 * Where to listen: the tailnet address on 31416. A development run may name
 * the address and the port (TARS_MACHINES_BIND, TARS_MACHINES_PORT, 0 for any
 * free port), as the e2e suite does to run two Tars on one machine; a
 * packaged Tars never reads them.
 */
export function resolveBindTarget(env: NodeJS.ProcessEnv, packaged: boolean, tailnetIp: string | undefined): BindTarget | { reason: string } {
  if (usesDevOverride(env, packaged)) {
    const host = (env.TARS_MACHINES_BIND ?? '').trim();
    const raw = env.TARS_MACHINES_PORT;
    const port = raw !== undefined && raw.trim() !== '' && Number.isInteger(Number(raw)) ? Number(raw) : MACHINES_PORT_DEFAULT;
    return isIpv4(host) ? { host, port } : { reason: `TARS_MACHINES_BIND must be one IPv4 address, not ${host || 'empty'}.` };
  }
  if (!tailnetIp || !isIpv4(tailnetIp)) return { reason: 'Tailscale is not running on this machine, so no other machine can reach it.' };
  return { host: tailnetIp, port: MACHINES_PORT_DEFAULT };
}

const now = () => (activeDeps?.now ?? Date.now)();

/** The offer still open, or null once used, closed, out of tries or past its five minutes. */
export const currentOffer = (): Offer | null => (offer && !offer.closed && now() <= offer.expiresAt ? offer : null);
export const bridgeState = () => ({ ...state });

/** A new code ends whatever the old one had started: a machine waiting on it, or one accepted for it. */
export function openPairingOffer(): Offer {
  request?.decide('closed');
  offer = openOffer(now());
  accepted = null;
  return offer;
}

export function closePairingOffer(): void {
  request?.decide('closed');
  if (offer) offer.closed = true;
  offer = null;
  accepted = null;
}

type Decision = 'accepted' | 'refused' | 'gone' | 'late' | 'closed';
/** The machine waiting for the person here, for one code. */
let request: { view: PairRequest; offer: Offer; decide: (d: Decision) => void } | null = null;
/** A knock between its arrival and its request: what Tailscale is asked meanwhile, for one knock at a time. */
let knocking = false;
/** The machine the person here accepted: it may prove that code, from its address, for a short while. */
let accepted: { id: string; name: string; address: string; offer: Offer; until: number } | null = null;
/** Long enough for the caller to send its proof once accepted, too short for anything else. */
const PROVE_WITHIN_MS = 30_000;

/** The machine waiting for the person here to accept it, or null. */
export const currentRequest = (): PairRequest | null => (request ? { ...request.view } : null);

/** The person here accepts or refuses the machine that waits; false when none does. */
export function decidePairRequest(accept: boolean): boolean {
  if (!request) return false;
  request.decide(accept ? 'accepted' : 'refused');
  return true;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | 'too-large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return 'too-large';
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const peerFor = (authorization: string | undefined): PairedMachine | undefined => {
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return presented ? readMachines().peers.find(p => secretMatches(presented, p.inboundSecretHash)) : undefined;
};

const ROUTES = new Set(['GET /machines/v1/hello', 'POST /machines/v1/knock', 'POST /machines/v1/pair', 'GET /machines/v1/ping', 'POST /machines/v1/unpair', 'GET /machines/v1/fleet']);
/** One agent's screen or live output (GET), or an action on it (POST): an id that fleet-share lets travel, and nothing else after it. */
const AGENT_ROUTE = /^\/machines\/v1\/agents\/([A-Za-z0-9_-]{1,64})\/(screen|stream|start|stop|message)$/;
const READS = new Set(['screen', 'stream']);

/** What a start's first prompt or a message may hold: a long brief, not a file. */
export const MAX_DRIVE_TEXT = 8000;
/** What this machine's side of an action answers: done, or why not, with its status. */
export type DriveOutcome = { ok: true } | { ok: false; status: 404 | 409; error: string };

/** Live outputs one machine may hold open at once: a Dashboard of every agent, with room to spare. */
export const MAX_STREAMS_PER_MACHINE = 32;
/** The live outputs open now, by the machine that opened them. */
const streams = new Map<string, number>();
/** Each live output open now, to cut a forgotten machine's at once (closeStreamsOf). */
const openStreams = new Set<{ peerId: string; cut: () => void }>();
/** What a slow reader may leave unsent before its stream is closed: it reads the screen again when it comes back. */
const MAX_UNSENT = 4 * 1024 * 1024;

export async function handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: BridgeDeps, opts: { tailnetOnly?: boolean } = {}): Promise<void> {
  activeDeps = deps;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (opts.tailnetOnly && !isTailnetAddress(req.socket.remoteAddress)) return send(403, { error: 'Forbidden' });
  // No browser ever calls the bridge: a page that tries is refused before anything is read.
  if (req.headers.origin) return send(403, { error: 'Forbidden' });
  const path = new URL(req.url || '/', 'http://bridge').pathname;
  const key = `${req.method} ${path}`;
  const matched = AGENT_ROUTE.exec(path);
  // A read by GET, an action by POST, and nothing else.
  const agentRoute = matched && (READS.has(matched[2]) ? req.method === 'GET' : req.method === 'POST') ? matched : null;
  if (!ROUTES.has(key) && !agentRoute) return send(404, { error: 'Not found' });

  if (key === 'GET /machines/v1/hello') {
    const open = currentOffer();
    if (!open) return send(404, { error: 'Not found' });
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, nonce: open.nonce });
  }

  const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  // A machine asks to pair, with no proof yet: the person here sees who asks,
  // by the MagicDNS name the tailnet keeps unique and its address, and accepts
  // or refuses. No proof travels before that, so a machine that answered hello
  // in this one's place gets one only to fail the five seconds that follow.
  if (key === 'POST /machines/v1/knock') {
    const body = await readBody(req);
    if (body === 'too-large') return send(413, { error: 'Too large' });
    const id = typeof body.id === 'string' && /^m-[0-9a-f]{16}$/.test(body.id) ? body.id : '';
    let name = '';
    try { name = cleanName(body.name); } catch { /* refused below */ }
    const self = readMachines().self;
    const mine = currentOffer();
    // The knock names the code its caller read in hello: one shown since then is not the one it typed.
    if (!mine || body.nonce !== mine.nonce || !id || !name) return send(403, { error: 'That code is not the one this machine shows, or it expired.' });
    if (id === self.id) return send(403, { error: 'A machine does not pair with itself.' });
    // One machine at a time, from its knock to the end of its half minute to prove the code.
    if (knocking || request || (accepted && now() <= accepted.until)) {
      return send(403, { error: `Another machine is waiting for an answer on ${self.name}. Try again in a minute.` });
    }
    knocking = true;
    let device: string | undefined;
    try { device = await deps.deviceAt?.(address); } catch { /* Tailscale did not answer: the address alone */ } finally { knocking = false; }
    if (req.socket.destroyed) return;
    if (currentOffer() !== mine) return send(403, { error: 'That code is not the one this machine shows, or it expired.' });
    // No longer than the code itself lives.
    const wait = Math.max(0, Math.min(deps.pairWaitMs ?? PAIR_WAIT_MS, mine.expiresAt - now()));
    const decision = await new Promise<Decision>((resolve) => {
      const decide = (d: Decision) => {
        if (request?.decide !== decide) return;
        clearTimeout(timer);
        request = null;
        resolve(d);
        deps.onRequestChanged?.();
      };
      const timer = setTimeout(() => decide('late'), wait);
      request = { view: { name, device, address, expiresAt: now() + wait }, offer: mine, decide };
      // A caller that gave up leaves nothing to accept.
      res.once('close', () => decide('gone'));
      deps.onRequestChanged?.();
    });
    if (decision === 'gone') return;
    if (decision === 'closed') return send(403, { error: `The code on ${self.name} changed or ran out. Type the one it shows now, or ask for a new one.` });
    if (decision !== 'accepted') {
      // A refusal, or no answer: this code is spent, and the person here opens another. A newer one is left alone.
      if (offer === mine) closePairingOffer();
      deps.onChanged();
      return send(403, { error: decision === 'refused' ? `${self.name} refused the pairing.` : `Nobody accepted the pairing on ${self.name} in time.` });
    }
    if (currentOffer() !== mine) return send(403, { error: 'That code is not the one this machine shows, or it expired.' });
    accepted = { id, name, address, offer: mine, until: now() + PROVE_WITHIN_MS };
    return send(200, { ok: true });
  }

  // The proof, from the machine the person here accepted, from its address,
  // under the name the person saw: nothing else is tried against the code.
  if (key === 'POST /machines/v1/pair') {
    const body = await readBody(req);
    if (body === 'too-large') return send(413, { error: 'Too large' });
    const open = currentOffer();
    const file = readMachines();
    const id = typeof body.id === 'string' && /^m-[0-9a-f]{16}$/.test(body.id) ? body.id : '';
    const port = Number(body.port);
    const theirs = isSecret(body.secret) ? body.secret : '';
    const callerNonce = isNonce(body.callerNonce) ? body.callerNonce : '';
    const ok = accepted && accepted.id === id && accepted.address === address && accepted.offer === open && now() <= accepted.until;
    if (!ok) return send(403, { error: `${file.self.name} has not accepted this machine. Pair again, and accept it there.` });
    const verdict = open && theirs && callerNonce && Number.isInteger(port) && port > 0 && port < 65536
      ? checkProof(open, typeof body.proof === 'string' ? body.proof : '', callerNonce, id, file.self.id, now())
      : 'wrong';
    if (verdict !== 'ok') {
      return send(403, { error: verdict === 'self' ? 'A machine does not pair with itself.' : 'That code is not the one this machine shows, or it expired.' });
    }
    const name = accepted!.name;
    accepted = null;
    offer = null;
    const issued = newSecret();
    const peers = file.peers.filter(p => p.id !== id);
    peers.push({ id, name, address, port, inboundSecretHash: hashSecret(issued), outboundSecret: theirs, mayOnMe: 'see', pairedAt: new Date(now()).toISOString() });
    // Written before the answer: a crash in between leaves the caller unpaired, never this side alone.
    writeMachines({ ...file, peers });
    deps.onChanged();
    // The code proved back, so the caller knows it is this machine that shows it.
    return send(200, { id: file.self.id, name: file.self.name, secret: issued, proof: answerProof(open!.code, open!.nonce, callerNonce, id, file.self.id) });
  }

  const peer = peerFor(req.headers.authorization);
  if (!peer) return send(401, { error: 'Unauthorized' });

  if (key === 'GET /machines/v1/ping') {
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, agentsRunning: deps.runningAgents() });
  }

  // What a paired machine sees of this one, whatever it may do here: its
  // agents (fleet-share.ts picks what travels), one agent's screen, and one
  // agent's live output.
  if (key === 'GET /machines/v1/fleet') {
    const { self } = readMachines();
    // What it may do here, so its window offers what this machine allows, and only that.
    return send(200, { id: self.id, name: self.name, youMay: peer.mayOnMe, agents: deps.fleet?.() ?? [] });
  }
  if (agentRoute && agentRoute[2] === 'screen') {
    const screen = deps.screenOf?.(agentRoute[1]);
    return screen ? send(200, { screen: screen.screen, cliRunning: screen.cliRunning, ...terminalSize(screen.cols, screen.rows) }) : send(404, { error: 'No such terminal' });
  }
  if (agentRoute && agentRoute[2] === 'stream') return streamOutput(agentRoute[1], peer, res, deps, send);
  if (agentRoute) return driveAgent(agentRoute[1], agentRoute[2] as 'start' | 'stop' | 'message', peer, req, deps, send);

  // The caller forgets this machine, and this machine forgets the caller, its live outputs with it.
  if (key === 'POST /machines/v1/unpair') {
    const file = readMachines();
    writeMachines({ ...file, peers: file.peers.filter(p => p.id !== peer.id) });
    closeStreamsOf(peer.id);
    deps.onChanged();
    return send(200, { ok: true });
  }
  // A route listed above with no answer here: never a fall-through into another's.
  return send(404, { error: 'Not found' });
}

/**
 * An action on one of this machine's agents, from a paired machine that this
 * one lets drive (Settings > Machines, read again at each request): start
 * with an optional first prompt, stop with a reason, or a message. Filed under
 * the name this machine paired the caller under, never one it sends.
 */
async function driveAgent(agentId: string, action: 'start' | 'stop' | 'message', peer: PairedMachine, req: http.IncomingMessage, deps: BridgeDeps, send: (status: number, body: unknown) => void): Promise<void> {
  const { self } = readMachines();
  if (peer.mayOnMe !== 'drive') return send(403, { error: `${self.name} lets ${peer.name} see only.` });
  const body = await readBody(req);
  if (body === 'too-large') return send(413, { error: 'Too large' });
  const tooLong = `A message to an agent is at most ${MAX_DRIVE_TEXT.toLocaleString('en-US')} characters.`;
  if (!deps.drive) return send(404, { error: 'No such agent' });
  let outcome: DriveOutcome;
  if (action === 'stop') {
    // One line of a card: any run of spaces and line breaks reads as one space.
    const reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : '';
    if (!reason) return send(400, { error: 'A stop needs a reason.' });
    outcome = await deps.drive.stop(agentId, peer.name, reason.slice(0, 200));
  } else if (action === 'message') {
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) return send(400, { error: 'A message needs some text.' });
    if (text.length > MAX_DRIVE_TEXT) return send(413, { error: tooLong });
    outcome = await deps.drive.message(agentId, peer.name, text);
  } else {
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : undefined;
    if (prompt && prompt.length > MAX_DRIVE_TEXT) return send(413, { error: tooLong });
    outcome = await deps.drive.start(agentId, peer.name, prompt);
  }
  return outcome.ok ? send(200, { ok: true }) : send(outcome.status, { error: outcome.error });
}

/**
 * One agent's live output as Server-Sent Events, one chunk per event, each a
 * JSON string so a line break or "data:" inside a chunk stays in it. Ends
 * with the terminal, when the caller goes, or when the caller reads too
 * slowly to keep up; a comment every fifteen seconds keeps an idle one open.
 */
function streamOutput(agentId: string, peer: PairedMachine, res: http.ServerResponse, deps: BridgeDeps, send: (status: number, body: unknown) => void): void {
  if ((streams.get(peer.id) ?? 0) >= MAX_STREAMS_PER_MACHINE) return send(429, { error: 'Too many live outputs open from this machine.' });
  let stop: (() => void) | null = null;
  let done = false;
  let keepAlive: NodeJS.Timeout | undefined = undefined;
  const open = { peerId: peer.id, cut: () => { end(); res.destroy(); } };
  // Every way out frees the slot once: the terminal ended, the caller went,
  // the pairing ended, or the caller read too slowly.
  const end = (finish = true) => {
    if (done) return;
    done = true;
    clearInterval(keepAlive);
    openStreams.delete(open);
    stop?.();
    streams.set(peer.id, Math.max(0, (streams.get(peer.id) ?? 1) - 1));
    if (finish && !res.writableEnded) res.end();
  };
  streams.set(peer.id, (streams.get(peer.id) ?? 0) + 1);
  openStreams.add(open);
  try {
    stop = deps.onOutput?.(agentId, (chunk) => {
      if (done) return;
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // Ended and cut: an end alone waits behind what was never read, and holds it.
      if (res.writableLength > MAX_UNSENT) open.cut();
    }, end) ?? null;
  } catch { stop = null; }
  if (!stop) {
    end(false);
    return send(404, { error: 'No such terminal' });
  }
  // The pairing is read again with each ping: forgotten here, or paired again
  // under another secret, the machine reads no further.
  keepAlive = setInterval(() => {
    const still = readMachines().peers.some(p => p.id === peer.id && p.inboundSecretHash === peer.inboundSecretHash);
    if (!still) return open.cut();
    res.write(': ping\n\n');
  }, deps.streamCheckMs ?? 15_000);
  res.on('close', end);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
}

/** Ends every live output a machine has open here, at once: it has just been forgotten. */
export function closeStreamsOf(peerId: string): void {
  for (const open of [...openStreams]) if (open.peerId === peerId) open.cut();
}

export function startBridge(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string; target?: BindTarget }> {
  activeDeps = deps;
  if (server) return Promise.resolve(bridgeState());
  starting ??= listen(deps).finally(() => { starting = null; });
  return starting;
}

async function listen(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string; target?: BindTarget }> {
  const tailscale = await detectTailscale();
  const packaged = app?.isPackaged ?? true;
  const target = resolveBindTarget(process.env, packaged, tailnetIp(tailscale));
  // Only a development run bound to 127.0.0.1 answers callers off the tailnet.
  const tailnetOnly = !usesDevOverride(process.env, packaged);
  if ('reason' in target) {
    state = { listening: false, reason: target.reason };
    return bridgeState();
  }
  const created = http.createServer((req, res) => {
    void handleBridgeRequest(req, res, deps, { tailnetOnly }).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  await new Promise<void>((resolve) => {
    const failed = (err: NodeJS.ErrnoException) => {
      state = { listening: false, reason: `The bridge could not listen on ${target.host}:${target.port} (${err.code}).` };
      resolve();
    };
    created.once('error', failed);
    created.listen(target.port, target.host, () => {
      // Listening: an error from now on is one connection's (an accept that
      // failed), not the listener's, and must neither say the bridge is down
      // nor go unhandled.
      created.off('error', failed);
      created.on('error', () => {});
      const bound = created.address();
      server = created;
      state = { listening: true, target: { host: target.host, port: typeof bound === 'object' && bound ? bound.port : target.port } };
      resolve();
    });
  });
  return bridgeState();
}

export function stopBridge(): Promise<void> {
  const s = server;
  server = null;
  state = { listening: false };
  return new Promise(resolve => (s ? s.close(() => resolve()) : resolve()));
}
