import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, revokeClient } from '../../../electron/services/cloud/clients';
import { startDoor, type Door } from '../../../electron/services/cloud/door';
import type { DriveRequest } from '../../../electron/services/cloud/drive';

/**
 * The door's drive routes (plan Task 7, keys and size).
 *
 * How it fails:
 * - a client without `drive` typing or resizing
 * - a client revoked between the request's head and its body still driving
 *   (the client is admitted again once the body is in)
 * - a chunked body over 64 KB read to its end
 * - a body that is not JSON driving anything
 * - an unknown agent answered differently from a known one before the
 *   credential is checked
 */

const doors: Door[] = [];
afterEach(async () => { for (const d of doors.splice(0)) await d.close(); });

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-drive-')), 'cloud-clients.json');
  const driven: Array<{ request: DriveRequest; caller: string }> = [];
  const deps = {
    port: 0,
    clientsFile: file,
    identity: () => ({ id: '0123456789abcdef', name: 'vps', version: '9.9.9' }),
    fleet: () => ({}),
    screenOf: (id: string) => (id === 'nova' ? { screen: '', cliRunning: true, cols: 80, rows: 24 } : null),
    drive: (request: DriveRequest, caller: { name: string }) => {
      if (request.agentId !== 'nova') return { ok: false as const, status: 404 as const, error: 'No such agent on this Tars server.' };
      driven.push({ request, caller: caller.name });
      return { ok: true as const };
    },
  };
  return { file, driven, deps };
}

async function open(deps: Parameters<typeof startDoor>[0]): Promise<Door> {
  const d = await startDoor(deps);
  doors.push(d);
  return d;
}

function post(port: number, urlPath: string, body: string, credential?: string, beforeBody?: () => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => {
      beforeBody?.();
      setTimeout(() => req.end(body), beforeBody ? 50 : 0);
    }, beforeBody ? 100 : 0);
  });
}

describe('drive routes', () => {
  it('type keys and set a size for a client with drive, under its name', async () => {
    const { deps, file, driven } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await open(deps);
    expect((await post(d.port, '/cloud/v1/agents/nova/keys', JSON.stringify({ data: 'ls\r' }), credential)).status).toBe(200);
    expect((await post(d.port, '/cloud/v1/agents/nova/size', JSON.stringify({ cols: 100, rows: 30 }), credential)).status).toBe(200);
    expect(driven).toEqual([
      { request: { action: 'keys', agentId: 'nova', data: 'ls\r' }, caller: 'Mac' },
      { request: { action: 'size', agentId: 'nova', cols: 100, rows: 30 }, caller: 'Mac' },
    ]);
  });

  it('refuse a client that may only see', async () => {
    const { deps, file, driven } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    const answer = await post(d.port, '/cloud/v1/agents/nova/keys', JSON.stringify({ data: 'x' }), credential);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toMatch(/vps does not let Mac drive/);
    expect(driven).toEqual([]);
  });

  it('refuse a client that may only see before its body is read', async () => {
    const { deps, file } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await open(deps);
    const status = await new Promise<number | 'no answer'>(resolve => {
      const req = http.request({ host: '127.0.0.1', port: d.port, path: '/cloud/v1/agents/nova/keys', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000', Authorization: `Bearer ${credential}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => resolve('no answer'));
      req.flushHeaders();
      setTimeout(() => { resolve('no answer'); req.destroy(); }, 1500);
    });
    expect(status).toBe(403);
  });

  it('refuse a client revoked between the head and the body', async () => {
    const { deps, file, driven } = setup();
    const { client, credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await open(deps);
    const answer = await post(d.port, '/cloud/v1/agents/nova/keys', JSON.stringify({ data: 'x' }), credential, () => revokeClient(file, client.id));
    expect(answer.status).toBe(401);
    expect(driven).toEqual([]);
  });

  it('stop reading a chunked body past 64 KB', async () => {
    const { deps, file, driven } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await open(deps);
    const answer = await post(d.port, '/cloud/v1/agents/nova/keys', JSON.stringify({ data: 'x'.repeat(70 * 1024) }), credential).catch(() => ({ status: 413, body: '' }));
    expect(answer.status).toBe(413);
    expect(driven).toEqual([]);
  });

  it('refuse a body that is not JSON', async () => {
    const { deps, file, driven } = setup();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await open(deps);
    expect((await post(d.port, '/cloud/v1/agents/nova/keys', 'not json', credential)).status).toBe(400);
    expect(driven).toEqual([]);
  });

  it('answer 401 for a known and an unknown agent alike without a credential', async () => {
    const { deps } = setup();
    const d = await open(deps);
    expect((await post(d.port, '/cloud/v1/agents/nova/keys', '{"data":"x"}')).status).toBe(401);
    expect((await post(d.port, '/cloud/v1/agents/ghost/keys', '{"data":"x"}')).status).toBe(401);
  });
});
