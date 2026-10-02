import * as http from 'http';
import { readMachines, writeMachines, newSecret, hashSecret } from './store';
import { codeProof } from './pairing';
import { MACHINES_PORT_DEFAULT } from './bridge-server';
import type { PairedMachine } from './types';

/**
 * This Tars calling another one's bridge (bridge-server.ts): to pair with
 * the code it shows, to ask whether it is there, and to tell it this
 * machine forgets it.
 */
export interface Candidate { host: string; port: number }
export type PairResult = { ok: true; name: string } | { ok: false; error: string };
export type PingResult = { status: 'connected'; agentsRunning: number } | { status: 'offline' } | { status: 'unpaired' };

function request(c: Candidate, method: string, path: string, opts: { secret?: string; body?: unknown; timeoutMs: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: c.host,
      port: c.port,
      path,
      method,
      timeout: opts.timeoutMs,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: {} }));
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
export function candidatesFrom(env: NodeJS.ProcessEnv, packaged: boolean, peers: { ip: string; online: boolean }[]): Candidate[] {
  if (!packaged && env.TARS_MACHINES_PEERS) {
    return env.TARS_MACHINES_PEERS.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [host, port] = s.split(':');
      return { host, port: Number(port) || MACHINES_PORT_DEFAULT };
    });
  }
  return peers.filter(p => p.online).map(p => ({ host: p.ip, port: MACHINES_PORT_DEFAULT }));
}

/** Pairs with the first candidate showing a code, proving the code over its nonce; the code itself never leaves. */
export async function pairWithCode(typed: string, candidates: Candidate[], myPort: number): Promise<PairResult> {
  const code = typed.replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, error: 'A pairing code is six digits.' };
  const file = readMachines();
  for (const c of candidates) {
    const hello = await request(c, 'GET', '/machines/v1/hello', { timeoutMs: 2_000 });
    if (hello.status !== 200 || typeof hello.body.nonce !== 'string') continue;
    const mine = newSecret();
    const answer = await request(c, 'POST', '/machines/v1/pair', {
      timeoutMs: 5_000,
      body: { id: file.self.id, name: file.self.name, port: myPort, proof: codeProof(code, hello.body.nonce, file.self.id), secret: mine },
    });
    if (answer.status !== 200) {
      return { ok: false, error: typeof answer.body.error === 'string' ? answer.body.error : 'The other machine refused the code.' };
    }
    const id = String(answer.body.id);
    const name = String(answer.body.name);
    const latest = readMachines();
    writeMachines({
      ...latest,
      peers: [...latest.peers.filter(p => p.id !== id), {
        id, name, address: c.host, port: c.port,
        inboundSecretHash: hashSecret(mine), outboundSecret: String(answer.body.secret),
        mayOnMe: 'see', pairedAt: new Date().toISOString(),
      }],
    });
    return { ok: true, name };
  }
  return { ok: false, error: 'No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first.' };
}

/** Whether a paired machine is there: 401 means it forgot this one, which is not the same as offline. */
export async function ping(peer: PairedMachine): Promise<PingResult> {
  const r = await request({ host: peer.address, port: peer.port }, 'GET', '/machines/v1/ping', { secret: peer.outboundSecret, timeoutMs: 3_000 });
  if (r.status === 200) return { status: 'connected', agentsRunning: Number(r.body.agentsRunning) || 0 };
  if (r.status === 401) return { status: 'unpaired' };
  return { status: 'offline' };
}

/** Tells the other machine (best effort: it may be off) and forgets it here, whatever it answered. */
export async function unpairPeer(peerId: string): Promise<void> {
  const peer = readMachines().peers.find(p => p.id === peerId);
  if (!peer) return;
  await request({ host: peer.address, port: peer.port }, 'POST', '/machines/v1/unpair', { secret: peer.outboundSecret, body: {}, timeoutMs: 3_000 });
  const latest = readMachines();
  writeMachines({ ...latest, peers: latest.peers.filter(p => p.id !== peerId) });
}
