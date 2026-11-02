import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, revokeClient } from '../../../electron/services/cloud/clients';
import { startDoor, MAX_STREAMS_PER_CLIENT, type Door } from '../../../electron/services/cloud/door';

/**
 * One agent's screen and live output, for a client with `see` (plan Task 6).
 *
 * How it fails:
 * - an unknown agent answered differently from a known one before the
 *   credential is checked (401 for both), or after it with a sentence that
 *   names the agent
 * - a client without `see` reading a screen or a stream
 * - a stream carrying another agent's output
 * - a 33rd stream from one client opened
 * - a revoked client's stream kept open (it ends within 2 s, another
 *   client's stays), or an expired client's past the next re-check
 * - a reader that does not read kept open past 4 MB behind
 */

const doors: Door[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const d of doors.splice(0)) await d.close();
});

type Listener = (agentId: string, chunk: string) => void;

function setup(opts: { recheckMs?: number; now?: () => number } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-see-')), 'cloud-clients.json');
  const listeners = new Set<Listener>();
  const emit = (agentId: string, chunk: string) => { for (const l of listeners) l(agentId, chunk); };
  const deps = {
    port: 0,
    clientsFile: file,
    identity: () => ({ id: '0123456789abcdef', name: 'vps', version: '9.9.9' }),
    fleet: () => ({}),
    screenOf: (agentId: string) => (agentId === 'nova' ? { screen: 'NOVA SCREEN', cliRunning: true, cols: 120, rows: 40 } : null),
    onOutput: (listener: Listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    recheckMs: opts.recheckMs,
    now: opts.now,
  };
  return { file, emit, listeners, deps };
}

async function open(deps: Parameters<typeof startDoor>[0]): Promise<Door> {
  const d = await startDoor(deps);
  doors.push(d);
  return d;
}

function get(port: number, urlPath: string, credential?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: credential ? { Authorization: `Bearer ${credential}` } : {} }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/** An open stream: its status, what it has received, and whether the door ended it. */
function stream(port: number, agentId: string, credential: string): Promise<{ status: number; received: () => string; ended: () => boolean; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/cloud/v1/agents/${agentId}/stream`, headers: { Authorization: `Bearer ${credential}` } }, res => {
      let received = '';
      let ended = false;
      res.on('data', c => { received += c; });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      resolve({ status: res.statusCode ?? 0, received: () => received, ended: () => ended, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

async function until(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  return check();
}

describe('screen', () => {
  it('answers 401 for a known and an unknown agent alike without a credential', async () => {
    const { deps } = setup();
    const d = await open(deps);
    expect((await get(d.port, '/cloud/v1/agents/nova/screen')).status).toBe(401);
    expect((await get(d.port, '/cloud/v1/agents/ghost/screen')).status).toBe(401);
  });

  it('refuses a client without see', async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Hermes', kind: 'outside-agent', scopes: ['create'] });
    const d = await open(deps);
    expect((await get(d.port, '/cloud/v1/agents/nova/screen', credential)).status).toBe(403);
    expect((await stream(d.port, 'nova', credential)).status).toBe(403);
  });

  it('gives a known agent\'s screen, and one sentence for an unknown one', async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    const known = await get(d.port, '/cloud/v1/agents/nova/screen', credential);
    expect(known.status).toBe(200);
    expect(JSON.parse(known.body)).toEqual({ screen: 'NOVA SCREEN', cliRunning: true, cols: 120, rows: 40 });
    const unknown = await get(d.port, '/cloud/v1/agents/ghost/screen', credential);
    expect(unknown.status).toBe(404);
    expect(unknown.body).not.toContain('ghost');
    expect((await stream(d.port, 'ghost', credential)).status).toBe(404);
  });
});

describe('stream', () => {
  it('carries that agent\'s output and no other\'s', async () => {
    const { deps, file, emit } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    const s = await stream(d.port, 'nova', credential);
    expect(s.status).toBe(200);
    emit('other', 'SECRET OF ANOTHER');
    emit('nova', 'line from nova');
    expect(await until(() => s.received().includes('line from nova'))).toBe(true);
    expect(s.received()).not.toContain('SECRET OF ANOTHER');
    s.close();
  });

  it(`opens ${MAX_STREAMS_PER_CLIENT} streams a client at most`, async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    const open32 = [];
    for (let i = 0; i < MAX_STREAMS_PER_CLIENT; i++) open32.push(await stream(d.port, 'nova', credential));
    expect(open32.every(s => s.status === 200)).toBe(true);
    expect((await stream(d.port, 'nova', credential)).status).toBe(429);
    for (const s of open32) s.close();
  });

  it('ends a revoked client\'s streams within 2 s, and no other client\'s', async () => {
    const { deps, file } = setup();
    const mac = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const pc = addClient(file, { name: 'PC', kind: 'desktop', scopes: ['see'] });
    const d = await open({ ...deps, recheckMs: 60_000 });
    const macStream = await stream(d.port, 'nova', mac.credential);
    const pcStream = await stream(d.port, 'nova', pc.credential);
    revokeClient(file, mac.client.id);
    expect(await until(() => macStream.ended(), 2000)).toBe(true);
    expect(pcStream.ended()).toBe(false);
    pcStream.close();
  });

  it('ends an expired client\'s stream at the next re-check', async () => {
    let now = Date.now();
    const { deps, file } = setup({ recheckMs: 100, now: () => now });
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'], days: 1 });
    const d = await open(deps);
    const s = await stream(d.port, 'nova', credential);
    expect(s.status).toBe(200);
    now += 2 * 86_400_000;
    expect(await until(() => s.ended(), 2000)).toBe(true);
  });

  it('ends a stream whose reader is 4 MB behind', async () => {
    const { deps, file, emit } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    // A reader that sends its request and never reads a byte.
    const socket = net.connect(d.port, '127.0.0.1');
    sockets.push(socket);
    socket.pause();
    socket.write(`GET /cloud/v1/agents/nova/stream HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nAuthorization: Bearer ${credential}\r\n\r\n`);
    expect(await until(() => d.streamCount() === 1)).toBe(true);
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 160 && d.streamCount() > 0; i++) {
      emit('nova', chunk);
      await new Promise(r => setImmediate(r));
    }
    expect(await until(() => d.streamCount() === 0, 3000)).toBe(true);
  });
});
