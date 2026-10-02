import * as http from 'http';
import { app } from 'electron';
import { readMachines, writeMachines, newSecret, hashSecret, secretMatches, cleanName } from './store';
import { Offer, openOffer, checkProof } from './pairing';
import { detectTailscale } from '../tailscale-status';
import type { PairedMachine } from './types';

/**
 * The machines bridge: how another Tars of the same tailnet reaches this one.
 *
 * A server of its own, apart from the loopback API (api-server.ts), which
 * never leaves 127.0.0.1 and whose token, pass and webhook secret are not
 * accepted here. It listens on this machine's Tailscale IPv4 only, never on
 * 0.0.0.0, and not at all without one. Four routes, listed below and nothing
 * else: an unknown path is 404 before any credential is read. A caller is a
 * paired machine when it presents the secret this Tars issued to it at
 * pairing (kept here as a hash). SECURITY.md, "The machines bridge".
 */
export const MACHINES_PORT_DEFAULT = 31416;
const MAX_BODY = 64 * 1024;

export interface BridgeDeps {
  /** Agents running on this machine, for ping. */
  runningAgents: () => number;
  /** Told after a pairing or an unpairing changed the file. */
  onChanged: () => void;
  now?: () => number;
}
export interface BindTarget { host: string; port: number }

let server: http.Server | null = null;
let state: { listening: boolean; reason?: string; target?: BindTarget } = { listening: false, reason: 'Not started.' };
let offer: Offer | null = null;
let activeDeps: BridgeDeps | null = null;

const isIpv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s) && s !== '0.0.0.0';

/**
 * Where to listen: the tailnet address on 31416. A development run may name
 * the address and the port (TARS_MACHINES_BIND, TARS_MACHINES_PORT, 0 for any
 * free port), as the e2e suite does to run two Tars on one machine; a
 * packaged Tars never reads them.
 */
export function resolveBindTarget(env: NodeJS.ProcessEnv, packaged: boolean, tailnetIp: string | undefined): BindTarget | { reason: string } {
  if (!packaged && env.TARS_MACHINES_BIND !== undefined) {
    const host = env.TARS_MACHINES_BIND.trim();
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

export function openPairingOffer(): Offer {
  offer = openOffer(now());
  return offer;
}

export function closePairingOffer(): void {
  if (offer) offer.closed = true;
  offer = null;
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

const ROUTES = new Set(['GET /machines/v1/hello', 'POST /machines/v1/pair', 'GET /machines/v1/ping', 'POST /machines/v1/unpair']);

export async function handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: BridgeDeps): Promise<void> {
  activeDeps = deps;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  // No browser ever calls the bridge: a page that tries is refused before anything is read.
  if (req.headers.origin) return send(403, { error: 'Forbidden' });
  const path = new URL(req.url || '/', 'http://bridge').pathname;
  const key = `${req.method} ${path}`;
  if (!ROUTES.has(key)) return send(404, { error: 'Not found' });

  if (key === 'GET /machines/v1/hello') {
    const open = currentOffer();
    if (!open) return send(404, { error: 'Not found' });
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, nonce: open.nonce });
  }

  if (key === 'POST /machines/v1/pair') {
    const body = await readBody(req);
    if (body === 'too-large') return send(413, { error: 'Too large' });
    const open = currentOffer();
    const file = readMachines();
    const id = typeof body.id === 'string' && /^m-[0-9a-f]{16}$/.test(body.id) ? body.id : '';
    const port = Number(body.port);
    const theirs = typeof body.secret === 'string' && body.secret.length >= 32 ? body.secret : '';
    let name = '';
    try { name = cleanName(body.name); } catch { /* refused below */ }
    const verdict = open && id && theirs && name && Number.isInteger(port) && port > 0 && port < 65536
      ? checkProof(open, typeof body.proof === 'string' ? body.proof : '', id, file.self.id, now())
      : 'wrong';
    if (verdict !== 'ok') {
      return send(403, { error: verdict === 'self' ? 'A machine does not pair with itself.' : 'That code is not the one this machine shows, or it expired.' });
    }
    const issued = newSecret();
    const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const peers = file.peers.filter(p => p.id !== id);
    peers.push({ id, name, address, port, inboundSecretHash: hashSecret(issued), outboundSecret: theirs, mayOnMe: 'see', pairedAt: new Date(now()).toISOString() });
    // Written before the answer: a crash in between leaves the caller unpaired, never this side alone.
    writeMachines({ ...file, peers });
    offer = null;
    deps.onChanged();
    return send(200, { id: file.self.id, name: file.self.name, secret: issued });
  }

  const peer = peerFor(req.headers.authorization);
  if (!peer) return send(401, { error: 'Unauthorized' });

  if (key === 'GET /machines/v1/ping') {
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, agentsRunning: deps.runningAgents() });
  }

  // POST /machines/v1/unpair: the caller forgets this machine, and this machine forgets the caller.
  const file = readMachines();
  writeMachines({ ...file, peers: file.peers.filter(p => p.id !== peer.id) });
  deps.onChanged();
  return send(200, { ok: true });
}

export async function startBridge(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string; target?: BindTarget }> {
  activeDeps = deps;
  if (server) return bridgeState();
  const tailscale = await detectTailscale();
  const target = resolveBindTarget(process.env, app?.isPackaged ?? true, tailscale.ip);
  if ('reason' in target) {
    state = { listening: false, reason: target.reason };
    return bridgeState();
  }
  const created = http.createServer((req, res) => {
    void handleBridgeRequest(req, res, deps).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  await new Promise<void>((resolve) => {
    created.once('error', (err: NodeJS.ErrnoException) => {
      state = { listening: false, reason: `The bridge could not listen on ${target.host}:${target.port} (${err.code}).` };
      resolve();
    });
    created.listen(target.port, target.host, () => {
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
  state = { listening: false, reason: 'Stopped.' };
  return new Promise(resolve => (s ? s.close(() => resolve()) : resolve()));
}
