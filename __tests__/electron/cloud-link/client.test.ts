import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, revokeClient } from '../../../electron/services/cloud/clients';
import { startDoor, type Door } from '../../../electron/services/cloud/door';
import { doorSocketPath } from '../../../electron/services/cloud/door-socket';
import type { DriveRequest } from '../../../electron/services/cloud/drive';
import { createDoorClient, type StreamEnd } from '../../../electron/services/cloud-link/client';

/**
 * The door's routes from the desktop (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 7, first half),
 * against a real door (a Unix socket; a named pipe on Windows).
 *
 * How it fails:
 * - a refusal (401 revoked, 403 no scope, 404 no such agent) read as a broken
 *   link, which the link would retry, or a broken link read as a refusal
 * - a refusal whose body never comes (the door closing after its head) read
 *   as a broken link
 * - a body over the door's 64 KB sent anyway (the door closes on it mid-write,
 *   and the refusal can be lost in the reset): refused here, never sent
 * - an answer over 4 MB read whole: cut, as no answer
 * - a call never settling when the door hangs or goes away
 * - the credential sent with hello, or a drive reaching the door without it
 *
 * The stream (second half):
 * - a chunk split across reads, or holding a blank line, cut or merged wrong
 * - another agent's output delivered
 * - the door ending it (revoke) read as a drop, or not ending it here at all
 * - a stream refused at its head left waiting
 * - onEnd said twice, or a chunk after it
 * - (M3 Task 7) a project or an agent not made through the door's create
 *   routes, the git key not read, a create body over 64 KB sent anyway, a
 *   403 for a client without create read as anything but a refusal
 */

const SERVER_ID = '0123456789abcdef';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';
const doors: Door[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const d of doors.splice(0)) await d.close();
  for (const s of servers.splice(0)) s.close();
});

async function setup(opts: { screen?: string; recheckMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-client-'));
  const clientsFile = path.join(dir, 'cloud-clients.json');
  const drives: Array<{ request: DriveRequest; caller: string }> = [];
  const listeners = new Set<(agentId: string, chunk: string) => void>();
  const emit = (agentId: string, chunk: string) => { for (const l of listeners) l(agentId, chunk); };
  const door = await startDoor({
    onOutput: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    recheckMs: opts.recheckMs,
    socketPath: doorSocketPath(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-'))),
    clientsFile,
    identity: () => ({ id: SERVER_ID, name: 'my-vps', version: '2.0.4' }),
    fleet: client => ({ agents: [{ id: 'nova', name: 'Nova', status: 'running' }], for: client.name }),
    screenOf: agentId => (agentId === 'nova' ? { screen: opts.screen ?? 'NOVA SCREEN', cliRunning: true, cols: 120, rows: 40 } : null),
    drive: async (request, caller) => {
      drives.push({ request, caller: caller.name });
      return { ok: true };
    },
    create: {
      projects: () => [{ name: 'test-cloud', path: '/home/tars/projects/test-cloud' }],
      project: async name => ({ ok: true, path: `/home/tars/projects/${name}` }),
      agent: async fields => ({ ok: true, agent: { id: 'a-new', name: String(fields.name) } }),
      gitKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAA tars-server', fingerprint: 'SHA256:abc' }),
      agentOf: agentId => (agentId === 'nova' ? { name: 'Nova', status: 'running' } : agentId === 'rest' ? { name: 'Rest', status: 'idle' } : null),
      remove: async () => ({}),
    },
  });
  doors.push(door);
  const end = { kind: 'unix' as const, path: door.path };
  return { clientsFile, door, end, drives, emit };
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  return check();
}

describe('creating through the client (M3 Task 7)', () => {
  it('makes a project and an agent and reads the git key; a client without create is told 403, a big body never sent', async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'PC', kind: 'desktop', scopes: ['see', 'drive', 'create'] });
    const client = createDoorClient(t.end, credential);
    expect(await client.createProject({ name: 'new-one', from: { kind: 'empty' } })).toEqual({ status: 201, body: { ok: true, project: { name: 'new-one', path: '/home/tars/projects/new-one' } } });
    expect(await client.createAgent({ projectName: 'test-cloud', name: 'Nova' })).toEqual({ status: 201, body: { ok: true, agent: { id: 'a-new', name: 'Nova' }, started: false } });
    expect(await client.gitKey()).toEqual({ status: 200, body: { publicKey: 'ssh-ed25519 AAAA tars-server', fingerprint: 'SHA256:abc' } });
    const old = addClient(t.clientsFile, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    expect((await createDoorClient(t.end, old.credential).createProject({ name: 'x', from: { kind: 'empty' } })).status).toBe(403);
    expect(await client.createAgent({ projectName: 'test-cloud', name: 'x'.repeat(65 * 1024) })).toMatchObject({ status: 413, body: { error: expect.stringMatching(/not sent/) } });
  });

  it("deletes one of the server's agents with DELETE, the door's refusal kept whole", async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'PC', kind: 'desktop', scopes: ['see', 'create'] });
    const client = createDoorClient(t.end, credential);
    expect(await client.removeAgent('rest')).toEqual({ status: 200, body: { ok: true } });
    expect(await client.removeAgent('nova')).toEqual({ status: 409, body: { error: 'Nova is at work on my-vps: stop it first, then delete it.' } });
  });
});

describe('the door through the client', () => {
  it('fleet and screen through the door', async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'PC-Nicolas (desktop)', kind: 'desktop', scopes: ['see', 'drive'] });
    const client = createDoorClient(t.end, credential);
    expect(await client.hello()).toEqual({ ok: true, serverId: SERVER_ID });
    expect(await client.fleet()).toEqual({ status: 200, body: { agents: [{ id: 'nova', name: 'Nova', status: 'running' }], for: 'PC-Nicolas (desktop)', projects: [{ name: 'test-cloud', path: '/home/tars/projects/test-cloud' }] } });
    expect(await client.screen('nova')).toEqual({ status: 200, body: { screen: 'NOVA SCREEN', cliRunning: true, cols: 120, rows: 40 } });
    expect(await client.drive('nova', 'keys', { data: 'ls\r' })).toEqual({ status: 200, body: { ok: true } });
    expect(t.drives).toEqual([{ request: { action: 'keys', agentId: 'nova', data: 'ls\r' }, caller: 'PC-Nicolas (desktop)' }]);
  });

  it('a refusal at the head is not a broken link', async () => {
    const t = await setup();
    const seeOnly = addClient(t.clientsFile, { name: 'Mac (desktop)', kind: 'desktop', scopes: ['see'] });
    const both = addClient(t.clientsFile, { name: 'PC (desktop)', kind: 'desktop', scopes: ['see', 'drive'] });
    expect((await createDoorClient(t.end, CREDENTIAL).fleet()).status).toBe(401);
    expect((await createDoorClient(t.end).fleet()).status).toBe(401);
    expect((await createDoorClient(t.end, seeOnly.credential).drive('nova', 'stop', { reason: 'done' })).status).toBe(403);
    expect((await createDoorClient(t.end, both.credential).screen('ghost')).status).toBe(404);
    const big = await createDoorClient(t.end, both.credential).drive('nova', 'keys', { data: 'x'.repeat(65 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/not sent/);
    expect(t.drives).toEqual([]);
  });

  it('a broken link is status 0, and settles', async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'PC (desktop)', kind: 'desktop', scopes: ['see'] });
    await t.door.close();
    doors.splice(0);
    const client = createDoorClient(t.end, credential);
    expect(await client.fleet()).toEqual({ status: 0, body: {} });
    expect(await client.hello()).toMatchObject({ ok: false });
  });

  it('a refusal whose body never comes is still that refusal; hello never carries the credential', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (req.url === '/cloud/v1/hello') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ v: 1, serverId: SERVER_ID }));
        return;
      }
      res.writeHead(401, { 'Content-Length': '200' });
      res.write('{"error":"Not a cli');
      setTimeout(() => res.destroy(), 20);
    });
    const socketPath = doorSocketPath(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-')));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    servers.push(server);
    const client = createDoorClient({ kind: 'unix', path: socketPath }, CREDENTIAL);
    expect(await client.hello()).toEqual({ ok: true, serverId: SERVER_ID });
    expect(await client.fleet()).toEqual({ status: 401, body: {} });
    expect(seen).toEqual([undefined, `Bearer ${CREDENTIAL}`]);
  });

  it('an answer over 4 MB is cut, as no answer', async () => {
    const t = await setup({ screen: 'x'.repeat(5 * 1024 * 1024) });
    const { credential } = addClient(t.clientsFile, { name: 'PC (desktop)', kind: 'desktop', scopes: ['see'] });
    expect(await createDoorClient(t.end, credential).screen('nova')).toEqual({ status: 0, body: {} });
  });
});

describe('the stream', () => {
  const ESC = String.fromCharCode(27);

  it("carries its agent's output in order, a chunk split across reads", async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'PC (desktop)', kind: 'desktop', scopes: ['see'] });
    const got: string[] = [];
    const ends: StreamEnd[] = [];
    let opens = 0;
    const stream = createDoorClient(t.end, credential).stream('nova', chunk => got.push(chunk), how => ends.push(how), { onOpen: () => { opens += 1; } });
    expect(await until(() => t.door.streamCount() === 1 && opens === 1)).toBe(true);
    const big = 'y'.repeat(300 * 1024);
    const sent = ['one ', big, `${ESC}[31mred${ESC}[0m\n\nafter a blank line`];
    t.emit('nova', sent[0]);
    t.emit('ghost', 'not this one');
    t.emit('nova', sent[1]);
    t.emit('nova', sent[2]);
    expect(await until(() => got.join('').length >= sent.join('').length)).toBe(true);
    expect(got.join('')).toBe(sent.join(''));
    stream.close();
    stream.close();
    t.emit('nova', 'after the end');
    await new Promise(r => setTimeout(r, 50));
    expect(ends).toEqual([{ reason: 'closed' }]);
    expect(got.join('')).toBe(sent.join(''));
  });

  it('revoke ends the open stream', async () => {
    // Minted after the door started: its next credential check (100 ms here) ends the stream at the latest.
    const t = await setup({ recheckMs: 100 });
    const { client, credential } = addClient(t.clientsFile, { name: 'PC (desktop)', kind: 'desktop', scopes: ['see'] });
    const ends: StreamEnd[] = [];
    createDoorClient(t.end, credential).stream('nova', () => {}, how => ends.push(how));
    expect(await until(() => t.door.streamCount() === 1)).toBe(true);
    expect(revokeClient(t.clientsFile, client.id)).toBe(true);
    expect(await until(() => ends.length > 0)).toBe(true);
    expect(ends).toEqual([{ reason: 'revoked' }]);
  });

  it('a stream refused at its head ends at once with its status', async () => {
    const t = await setup();
    const { credential } = addClient(t.clientsFile, { name: 'Hermes', kind: 'outside-agent', scopes: ['create'] });
    const ends: StreamEnd[] = [];
    let opens = 0;
    createDoorClient(t.end, credential).stream('nova', () => {}, how => ends.push(how), { onOpen: () => { opens += 1; } });
    expect(await until(() => ends.length > 0)).toBe(true);
    expect(ends).toEqual([{ reason: 'refused', status: 403 }]);
    expect(opens).toBe(0);
  });
});
