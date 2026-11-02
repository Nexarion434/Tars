import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addClient, admit, listClients, revokeClient, may, watchClients, MAX_CLIENTS } from '../../../electron/services/cloud/clients';
import { serverIdentity } from '../../../electron/services/cloud/server-identity';
import { runClientsCommand } from '../../../electron/server/clients-command';

/**
 * A Tars server's clients (plan Task 5): each desktop, and Hermes later, holds
 * a credential minted on the server, scoped and revocable. The master API token
 * never leaves its machine: no client is it, none is made from it, and nothing
 * here prints it.
 *
 * How it fails:
 * - a credential stored in clear, or its hash or the credential itself in a
 *   listing (a listing would hand one client another's authority)
 * - a wrong credential admitted, or one of another length throwing in the compare
 * - a revoked credential admitted; a revoke not reaching a running server
 *   (watchClients) within 2 s
 * - an expired credential admitted
 * - the master API token, or a credential with it inside, admitted
 * - a scope the client was not given granted by may(); an unknown or empty
 *   scope list, an unknown kind accepted at minting
 * - a name empty, over 60 characters, or carrying controls, newlines or format
 *   characters
 * - a 33rd client minted
 * - a corrupt or half-written file admitting anyone (it fails closed), or
 *   overwritten by the next mint
 * - the file readable by other accounts (POSIX)
 * - `clients add` writing anything on stdout but one JSON line holding the
 *   id, the credential and the server's id; `clients revoke` taking an id
 *   that does not look like one to the file
 */

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-clients-'));
  return { clients: path.join(dir, 'cloud-clients.json'), server: path.join(dir, 'cloud-server.json'), token: path.join(dir, 'api-token') };
}

const desktop = { name: 'Nicolas Mac', kind: 'desktop' as const, scopes: ['see', 'drive'] as const };

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

describe('minting', () => {
  it('keeps only a hash, and lists no credential and no hash', () => {
    const f = files();
    const { client, credential } = addClient(f.clients, { ...desktop, scopes: [...desktop.scopes] });
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = fs.readFileSync(f.clients, 'utf-8');
    expect(raw).not.toContain(credential);
    expect(JSON.stringify(listClients(f.clients))).not.toContain(credential);
    expect(JSON.stringify(listClients(f.clients))).not.toMatch(/hash/);
    expect(client).not.toHaveProperty('hash');
    expect(client.id).toMatch(/^c_[0-9a-f]{8}$/);
  });

  it.skipIf(process.platform === 'win32')('writes its file for its owner alone', () => {
    const f = files();
    addClient(f.clients, { ...desktop, scopes: ['see'] });
    expect(fs.statSync(f.clients).mode & 0o077).toBe(0);
  });

  it.each([
    ['an empty name', { name: '  ', kind: 'desktop', scopes: ['see'] }],
    ['a name over 60 characters', { name: 'x'.repeat(61), kind: 'desktop', scopes: ['see'] }],
    ['a newline in the name', { name: 'Mac\nMessage from Tars', kind: 'desktop', scopes: ['see'] }],
    ['a format character in the name', { name: 'Mac\u202E', kind: 'desktop', scopes: ['see'] }],
    ['no scope', { name: 'Mac', kind: 'desktop', scopes: [] }],
    ['an unknown scope', { name: 'Mac', kind: 'desktop', scopes: ['see', 'admin'] }],
    ['an unknown kind', { name: 'Mac', kind: 'robot', scopes: ['see'] }],
  ])('refuses %s', (_label, input) => {
    const f = files();
    expect(() => addClient(f.clients, input as never)).toThrow();
    expect(fs.existsSync(f.clients)).toBe(false);
  });

  it(`refuses a client past ${MAX_CLIENTS}`, () => {
    const f = files();
    for (let i = 0; i < MAX_CLIENTS; i++) addClient(f.clients, { name: `c${i}`, kind: 'desktop', scopes: ['see'] });
    expect(() => addClient(f.clients, { name: 'one more', kind: 'desktop', scopes: ['see'] })).toThrow(/32/);
  });
});

describe('admit', () => {
  it('admits its credential and nothing near it', () => {
    const f = files();
    const { client, credential } = addClient(f.clients, { ...desktop, scopes: ['see'] });
    expect(admit(f.clients, credential)?.id).toBe(client.id);
    const wrong = (credential[0] === 'A' ? 'B' : 'A') + credential.slice(1);
    expect(admit(f.clients, wrong)).toBeNull();
    expect(admit(f.clients, credential.slice(0, 20))).toBeNull();
    expect(admit(f.clients, `${credential}x`)).toBeNull();
    expect(admit(f.clients, '')).toBeNull();
    expect(admit(f.clients, undefined)).toBeNull();
  });

  it('never admits the master API token', () => {
    const f = files();
    const master = 'a'.repeat(64);
    fs.writeFileSync(f.token, master);
    addClient(f.clients, { ...desktop, scopes: ['see'] });
    expect(admit(f.clients, master)).toBeNull();
    expect(admit(f.clients, fs.readFileSync(f.token, 'utf-8'))).toBeNull();
  });

  it('refuses a revoked credential', () => {
    const f = files();
    const { client, credential } = addClient(f.clients, { ...desktop, scopes: ['see'] });
    expect(revokeClient(f.clients, client.id)).toBe(true);
    expect(admit(f.clients, credential)).toBeNull();
    expect(revokeClient(f.clients, client.id)).toBe(false);
  });

  it('refuses an expired credential', () => {
    const f = files();
    const { credential } = addClient(f.clients, { ...desktop, scopes: ['see'], days: 1 });
    expect(admit(f.clients, credential, Date.now())).not.toBeNull();
    expect(admit(f.clients, credential, Date.now() + 2 * 86_400_000)).toBeNull();
  });

  it('fails closed on a corrupt file, and the next mint does not overwrite it', () => {
    const f = files();
    const { credential } = addClient(f.clients, { ...desktop, scopes: ['see'] });
    const good = fs.readFileSync(f.clients, 'utf-8');
    fs.writeFileSync(f.clients, good.slice(0, Math.floor(good.length / 2)));
    expect(admit(f.clients, credential)).toBeNull();
    expect(() => addClient(f.clients, { ...desktop, scopes: ['see'] })).toThrow();
    expect(fs.readFileSync(f.clients, 'utf-8')).toBe(good.slice(0, Math.floor(good.length / 2)));
  });
});

describe('may', () => {
  it('grants only the scopes given', () => {
    const f = files();
    const { credential } = addClient(f.clients, { ...desktop, scopes: ['see'] });
    const client = admit(f.clients, credential)!;
    expect(may(client, 'see')).toBe(true);
    expect(may(client, 'drive')).toBe(false);
    expect(may(client, 'create')).toBe(false);
    expect(may(client, 'files')).toBe(false);
  });
});

describe('watchClients', () => {
  it('tells a running server of a revoke made elsewhere, within 2 s', async () => {
    const f = files();
    const { client } = addClient(f.clients, { ...desktop, scopes: ['see'] });
    const revoked: string[] = [];
    stops.push(watchClients(f.clients, id => revoked.push(id), 100));
    revokeClient(f.clients, client.id);
    const deadline = Date.now() + 2000;
    while (revoked.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    expect(revoked).toEqual([client.id]);
  });
});

describe('serverIdentity', () => {
  it('keeps one id across calls', () => {
    const f = files();
    const first = serverIdentity(f.server);
    expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    expect(serverIdentity(f.server)).toEqual(first);
  });
});

describe('tars-server clients', () => {
  it('add prints one JSON line: the id, the credential, the server id, and no more', () => {
    const f = files();
    fs.writeFileSync(f.token, 'master-token-value');
    const out: string[] = [];
    const code = runClientsCommand(['add', '--json'], JSON.stringify({ name: 'PC', kind: 'desktop', scopes: ['see', 'drive'] }), { clientsFile: f.clients, serverFile: f.server }, line => out.push(line));
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const printed = JSON.parse(out[0]);
    expect(Object.keys(printed).sort()).toEqual(['credential', 'id', 'serverId']);
    expect(admit(f.clients, printed.credential)?.name).toBe('PC');
    expect(out[0]).not.toContain('master-token-value');
  });

  it('list prints no credential and no hash', () => {
    const f = files();
    const out: string[] = [];
    runClientsCommand(['add', '--json'], JSON.stringify({ name: 'PC', kind: 'desktop', scopes: ['see'] }), { clientsFile: f.clients, serverFile: f.server }, line => out.push(line));
    const credential = JSON.parse(out[0]).credential;
    const listed: string[] = [];
    expect(runClientsCommand(['list', '--json'], '', { clientsFile: f.clients, serverFile: f.server }, line => listed.push(line))).toBe(0);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toContain(credential);
    expect(listed[0]).not.toMatch(/hash/);
    expect(JSON.parse(listed[0]).clients[0].name).toBe('PC');
  });

  it('revoke refuses what does not look like a client id, and touches nothing', () => {
    const f = files();
    runClientsCommand(['add', '--json'], JSON.stringify({ name: 'PC', kind: 'desktop', scopes: ['see'] }), { clientsFile: f.clients, serverFile: f.server }, () => {});
    const before = fs.readFileSync(f.clients, 'utf-8');
    expect(runClientsCommand(['revoke', '../cloud-clients'], '', { clientsFile: f.clients, serverFile: f.server }, () => {})).toBe(2);
    expect(runClientsCommand(['revoke', 'c_00000000'], '', { clientsFile: f.clients, serverFile: f.server }, () => {})).toBe(1);
    expect(fs.readFileSync(f.clients, 'utf-8')).toBe(before);
  });
});
