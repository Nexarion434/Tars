import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, revokeClient } from '../../../electron/services/cloud/clients';
import { startDoor, type Door } from '../../../electron/services/cloud/door';
import { doorSocketPath } from '../../../electron/services/cloud/door-socket';

/** A socket in a folder of its own (0700, as mkdtemp makes it); a named pipe on Windows. */
function testSocketPath(): string {
  return doorSocketPath(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-')));
}

/**
 * The door (plan Task 6): the one listener a desktop reaches, through its SSH
 * forward, and Hermes on the server itself. It admits client credentials only,
 * each within its scopes, and nothing that is not on this machine.
 *
 * How it fails:
 * - listening anywhere but 127.0.0.1, or answering a caller whose address is
 *   not loopback
 * - answering a request that carries Origin (a web page), or whose Host is not
 *   127.0.0.1:<port> or localhost:<port> (a page rebinding a name to the forward)
 * - an unknown path answered with anything but 404, or after the credential
 *   was looked at (no route tells whether a credential is good)
 * - a body over 64 KB read
 * - no, a wrong, a revoked or an expired credential admitted; the master API
 *   token admitted; a credential taken from the query string
 * - a client without `see` reading the fleet
 * - hello carrying anything but v, serverId, name and version
 */

const doors: Door[] = [];
afterEach(async () => { for (const d of doors.splice(0)) await d.close(); });

function clientsFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-')), 'cloud-clients.json');
}

async function door(file: string, now = () => Date.now()): Promise<Door> {
  const d = await startDoor({
    socketPath: testSocketPath(),
    clientsFile: file,
    identity: () => ({ id: '0123456789abcdef', name: 'vps', version: '9.9.9' }),
    fleet: client => ({ v: 1, server: { id: '0123456789abcdef', name: 'vps' }, youMay: client.scopes, projects: [], agents: [] }),
    now,
  });
  doors.push(d);
  return d;
}

function request(socketPath: string, options: { path: string; method?: string; headers?: Record<string, string>; body?: string; host?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const bearer = (credential: string) => ({ Authorization: `Bearer ${credential}` });

describe('where the door listens', () => {
  it.skipIf(process.platform === 'win32')('listens on a socket only its owner may open', async () => {
    const d = await door(clientsFile());
    expect(fs.statSync(d.path).isSocket()).toBe(true);
    expect(fs.statSync(d.path).mode & 0o077).toBe(0);
  });
});

describe('what the door refuses before anything else', () => {
  it('a request carrying Origin, credential or not', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await door(file);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: { ...bearer(credential), Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request(d.path, { path: '/cloud/v1/hello', headers: { Origin: 'null' } })).status).toBe(403);
  });

  it('a Host that is not this loopback port', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await door(file);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: { ...bearer(credential), Host: 'evil.example' } })).status).toBe(403);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: { ...bearer(credential), Host: 'localhost:5555' } })).status).toBe(200);
  });

  it('an unknown path, with 404 whatever the credential', async () => {
    const d = await door(clientsFile());
    expect((await request(d.path, { path: '/api/agents' })).status).toBe(404);
    expect((await request(d.path, { path: '/cloud/v1/fleet', method: 'DELETE' })).status).toBe(404);
    expect((await request(d.path, { path: '/cloud/v1/nothing', headers: bearer('x'.repeat(43)) })).status).toBe(404);
  });

  it('a body over 64 KB, unread', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await door(file);
    const big = 'x'.repeat(65 * 1024);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: { ...bearer(credential), 'Content-Length': String(big.length) }, body: big })).status).toBe(413);
  });
});

describe('who the door admits', () => {
  it('no credential, a wrong one, the master token, one in the query: 401', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await door(file);
    expect((await request(d.path, { path: '/cloud/v1/fleet' })).status).toBe(401);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(`${credential.slice(0, 42)}A`) })).status).toBe(401);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer('f'.repeat(64)) })).status).toBe(401);
    expect((await request(d.path, { path: `/cloud/v1/fleet?credential=${credential}` })).status).toBe(401);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: { Authorization: credential } })).status).toBe(401);
  });

  it('a revoked credential: 401 at the next request', async () => {
    const file = clientsFile();
    const { client, credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'] });
    const d = await door(file);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) })).status).toBe(200);
    revokeClient(file, client.id);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) })).status).toBe(401);
  });

  it('an expired credential: 401', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see'], days: 1 });
    let now = Date.now();
    const d = await door(file, () => now);
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) })).status).toBe(200);
    now += 2 * 86_400_000;
    expect((await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) })).status).toBe(401);
  });

  it('a client without see, on the fleet: 403', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Hermes', kind: 'outside-agent', scopes: ['create'] });
    const d = await door(file);
    const answer = await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toMatch(/Hermes/);
  });

  it('a client with see, on the fleet: 200, told what it may do', async () => {
    const file = clientsFile();
    const { credential } = addClient(file, { name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] });
    const d = await door(file);
    const answer = await request(d.path, { path: '/cloud/v1/fleet', headers: bearer(credential) });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).youMay).toEqual(['see', 'drive']);
  });
});

describe('hello', () => {
  it('needs no credential and says only who the server is', async () => {
    const d = await door(clientsFile());
    const answer = await request(d.path, { path: '/cloud/v1/hello' });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ v: 1, serverId: '0123456789abcdef', name: 'vps', version: '9.9.9' });
  });
});
