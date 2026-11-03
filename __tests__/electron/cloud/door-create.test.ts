import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, revokeClient } from '../../../electron/services/cloud/clients';
import { startDoor, type Door, type DoorCreate } from '../../../electron/services/cloud/door';
import { doorSocketPath } from '../../../electron/services/cloud/door-socket';
import type { DriveRequest } from '../../../electron/services/cloud/drive';

/**
 * The door's create routes (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 4): POST /cloud/v1/projects, POST /cloud/v1/agents, GET /cloud/v1/git-key,
 * and the fleet's projects.
 *
 * How it fails, written before the code:
 * 1. a client without `create` creating anything, or reading the server's
 *    git key (403, nothing made)
 * 2. an outside agent (Hermes) creating, whatever its scopes (decision 4)
 * 3. a client revoked, or stripped of `create`, while its body was on the
 *    way, still creating (admitted again once the body is in)
 * 4. a body over 64 KB, or not a JSON object, creating anything
 * 5. a project's refusal (a taken name, a bad address) not coming back with
 *    its status and sentence
 * 6. an agent created in a folder that is not one of the server's projects;
 *    a client choosing the CLI's binary, a second folder or a role (a
 *    binary of its choosing would run on the server at the first start)
 * 7. creating an agent starting it; `start` starting it for a client
 *    without `drive`; the start not going through the drive executor (its
 *    memory floor and its checks)
 * 8. the git key's private half, or anything but the public key and its
 *    fingerprint, in an answer
 * 9. the fleet without the server's projects, or with more than their names
 *    and paths
 * 11. (security review 1, N8) an agent made with a name that is not a short
 *    string, or a character Tars does not draw
 * 10. (security review 1, B1) a clone asked without the client's explicit
 *    trust in the repository's code reaching the clone, or the client's word
 *    passed on without who gave it (the client's own name, never the body's)
 */

const doors: Door[] = [];
afterEach(async () => { for (const d of doors.splice(0)) await d.close(); });

const PROJECTS = [{ name: 'test-cloud', path: '/home/tars/projects/test-cloud' }];

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-create-')), 'cloud-clients.json');
  const made: Array<{ what: string; args: unknown[] }> = [];
  const driven: DriveRequest[] = [];
  const create: DoorCreate = {
    projects: () => PROJECTS,
    project: async (name, from) => {
      made.push({ what: 'project', args: [name, from] });
      return name === 'taken' ? { ok: false, status: 409, error: 'A project named "taken" is already on this server.' } : { ok: true, path: `/home/tars/projects/${name}` };
    },
    agent: async (fields) => {
      made.push({ what: 'agent', args: [fields] });
      return { ok: true, agent: { id: 'a-new', name: String(fields.name) } };
    },
    gitKey: async () => ({ ok: true, publicKey: 'ssh-ed25519 AAAA tars-server', fingerprint: 'SHA256:abc' }),
  };
  const deps = {
    socketPath: doorSocketPath(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-'))),
    clientsFile: file,
    identity: () => ({ id: '0123456789abcdef', name: 'vps', version: '9.9.9' }),
    fleet: () => ({ youMay: ['see'], agents: [] }),
    drive: async (request: DriveRequest) => { driven.push(request); return { ok: true as const }; },
    create,
  };
  return { file, made, driven, deps };
}

async function open(deps: Parameters<typeof startDoor>[0]): Promise<Door> {
  const d = await startDoor(deps);
  doors.push(d);
  return d;
}

function call(socketPath: string, method: string, urlPath: string, body: string | null, credential?: string, beforeBody?: () => void): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ socketPath, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } }, res => {
      answered = true;
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPIPE' || code === 'ECONNRESET') setTimeout(() => { if (!answered) reject(err); }, 500);
      else reject(err);
    });
    if (body === null) { req.end(); return; }
    req.flushHeaders();
    setTimeout(() => {
      beforeBody?.();
      setTimeout(() => { if (!answered && !req.destroyed) req.end(body); }, beforeBody ? 50 : 0);
    }, beforeBody ? 100 : 0);
  });
}

const PROJECT = JSON.stringify({ name: 'new-one', from: { kind: 'empty' } });
const AGENT = JSON.stringify({ projectName: 'test-cloud', name: 'Nova', provider: 'claude', model: 'haiku' });

describe('the create routes', () => {
  it('1. a client without create makes nothing and reads no key', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await open(deps);
    expect((await call(d.path, 'POST', '/cloud/v1/projects', PROJECT, credential)).status).toBe(403);
    expect((await call(d.path, 'POST', '/cloud/v1/agents', AGENT, credential)).status).toBe(403);
    expect((await call(d.path, 'GET', '/cloud/v1/git-key', null, credential)).status).toBe(403);
    expect(made).toEqual([]);
  });

  it('2. an outside agent never creates, whatever its scopes', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'Hermes', kind: 'outside-agent', scopes: ['see', 'drive', 'create'] });
    const d = await open(deps);
    for (const [method, url, body] of [['POST', '/cloud/v1/projects', PROJECT], ['POST', '/cloud/v1/agents', AGENT], ['GET', '/cloud/v1/git-key', null]] as const) {
      const answer = await call(d.path, method, url, body, credential);
      expect(answer.status, url).toBe(403);
      expect(String(answer.body.error), url).toMatch(/outside agent/);
    }
    expect(made).toEqual([]);
  });

  it('3. a client revoked while its body was on the way makes nothing', async () => {
    const { deps, file, made } = setup();
    const { client, credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    const answer = await call(d.path, 'POST', '/cloud/v1/projects', PROJECT, credential, () => revokeClient(file, client.id));
    expect(answer.status).toBe(401);
    expect(made).toEqual([]);
  });

  it('4. a body that is not a JSON object, or over 64 KB, makes nothing', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    expect((await call(d.path, 'POST', '/cloud/v1/projects', 'not json', credential)).status).toBe(400);
    expect((await call(d.path, 'POST', '/cloud/v1/projects', JSON.stringify({ name: 'x'.repeat(70 * 1024) }), credential)).status).toBe(413);
    expect(made).toEqual([]);
  });

  it('5. a project: made from the name and where it comes from, its refusal passed on', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    expect(await call(d.path, 'POST', '/cloud/v1/projects', PROJECT, credential)).toEqual({ status: 201, body: { ok: true, project: { name: 'new-one', path: '/home/tars/projects/new-one' } } });
    expect(made).toEqual([{ what: 'project', args: ['new-one', { kind: 'empty' }] }]);
    const taken = await call(d.path, 'POST', '/cloud/v1/projects', JSON.stringify({ name: 'taken', from: { kind: 'git', url: 'https://github.com/a/b', trusted: true } }), credential);
    expect(taken).toEqual({ status: 409, body: { error: 'A project named "taken" is already on this server.' } });
    expect((await call(d.path, 'POST', '/cloud/v1/projects', JSON.stringify({ name: 'x', from: 'somewhere' }), credential)).status).toBe(400);
  });

  it('11. an agent\'s name is a string of 80 at most, its character one Tars draws', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'PC-Nicolas', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    for (const extra of [{ name: 42 }, { name: { a: 1 } }, { name: 'x'.repeat(81) }, { character: 'dragon' }, { character: 7 }]) {
      const answer = await call(d.path, 'POST', '/cloud/v1/agents', JSON.stringify({ projectName: 'test-cloud', ...extra }), credential);
      expect(answer.status, JSON.stringify(extra)).toBe(400);
    }
    expect(made).toEqual([]);
    expect((await call(d.path, 'POST', '/cloud/v1/agents', JSON.stringify({ projectName: 'test-cloud', name: 'x'.repeat(80), character: 'robot' }), credential)).status).toBe(201);
  });

  it('10. a clone only with the client\'s trust in its code, passed on with the client\'s own name', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'PC-Nicolas', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    for (const trusted of [undefined, false, 'yes', 1]) {
      const answer = await call(d.path, 'POST', '/cloud/v1/projects', JSON.stringify({ name: 'repo', from: { kind: 'git', url: 'https://github.com/a/b', trusted } }), credential);
      expect(answer.status, String(trusted)).toBe(400);
      expect(String(answer.body.error)).toMatch(/trust this repository's code/);
    }
    expect(made).toEqual([]);
    const body = JSON.stringify({ name: 'repo', from: { kind: 'git', url: 'https://github.com/a/b', trusted: true, by: 'someone else' } });
    expect((await call(d.path, 'POST', '/cloud/v1/projects', body, credential)).status).toBe(201);
    expect(made).toEqual([{ what: 'project', args: ['repo', { kind: 'git', url: 'https://github.com/a/b', trusted: true, by: 'PC-Nicolas' }] }]);
  });

  it('6. an agent only in one of the server\'s projects, and never with a binary, a second folder or a role', async () => {
    const { deps, file, made } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    expect((await call(d.path, 'POST', '/cloud/v1/agents', JSON.stringify({ projectName: 'elsewhere', name: 'Nova' }), credential)).status).toBe(404);
    expect((await call(d.path, 'POST', '/cloud/v1/agents', JSON.stringify({ projectPath: '/etc', name: 'Nova' }), credential)).status).toBe(404);
    for (const extra of [{ cliPath: '/bin/sh' }, { secondaryProjectPath: '/home/tars' }, { role: 'orchestrator' }, { orchestratorMode: true }]) {
      const answer = await call(d.path, 'POST', '/cloud/v1/agents', JSON.stringify({ projectName: 'test-cloud', name: 'Nova', ...extra }), credential);
      expect(answer.status, JSON.stringify(extra)).toBe(400);
    }
    expect(made).toEqual([]);
    const created = await call(d.path, 'POST', '/cloud/v1/agents', AGENT, credential);
    expect(created).toEqual({ status: 201, body: { ok: true, agent: { id: 'a-new', name: 'Nova' }, started: false } });
    expect(made).toEqual([{ what: 'agent', args: [{ projectPath: '/home/tars/projects/test-cloud', name: 'Nova', provider: 'claude', model: 'haiku' }] }]);
  });

  it('7. start: through the drive executor, and only for a client that may drive', async () => {
    const { deps, file, driven } = setup();
    const creator = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const driver = addClient(file, { name: 'PC', kind: 'desktop', scopes: ['see', 'drive', 'create'] });
    const d = await open(deps);
    const body = JSON.stringify({ projectName: 'test-cloud', name: 'Nova', start: true });
    const notStarted = await call(d.path, 'POST', '/cloud/v1/agents', body, creator.credential);
    expect(notStarted.status).toBe(201);
    expect(notStarted.body).toMatchObject({ ok: true, started: false, startError: expect.stringMatching(/drive/) });
    expect(driven).toEqual([]);
    expect(await call(d.path, 'POST', '/cloud/v1/agents', body, driver.credential)).toMatchObject({ status: 201, body: { started: true } });
    expect(driven).toEqual([{ action: 'start', agentId: 'a-new' }]);
  });

  it('8. the git key: its public half and fingerprint, nothing else', async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'create'] });
    const d = await open(deps);
    expect(await call(d.path, 'GET', '/cloud/v1/git-key', null, credential)).toEqual({ status: 200, body: { publicKey: 'ssh-ed25519 AAAA tars-server', fingerprint: 'SHA256:abc' } });
  });

  it('9. the fleet carries the server\'s projects, names and paths', async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    expect(await call(d.path, 'GET', '/cloud/v1/fleet', null, credential)).toEqual({ status: 200, body: { youMay: ['see'], agents: [], projects: PROJECTS } });
  });
});
