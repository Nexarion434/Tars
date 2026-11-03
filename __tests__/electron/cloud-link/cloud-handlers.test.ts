import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { directRoute, registerCloudHandlers } from '../../../electron/handlers/cloud-handlers';
import { readLink } from '../../../electron/services/cloud-link/store';
import type { RunResult } from '../../../electron/services/cloud-link/remote-run';
import type { ServerCommand } from '../../../electron/services/cloud-link/ssh';
import type { DoorClient } from '../../../electron/services/cloud-link/client';

/**
 * window.electronAPI.cloud, as main answers it (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 9).
 *
 * How it fails:
 * - a desktop with no server configured spawning an `ssh` or arming a timer
 *   (the link is off by default)
 * - a window call with an id of another shape (a local agent id, a path, a
 *   client id with a shell character) reaching the link, the fleet or `ssh`
 * - anything sent to the window (an answer or a broadcast) holding the
 *   credential, the door's socket path, or a host key line
 * - the window setting a profile's credential, server id or client id
 * - a profile's host changed under its credential
 * - the E2E's direct route (no ssh) taken by a packaged app
 * - a client's name, kind or note shown with characters nobody sees, or a
 *   list of scopes without end
 * - a server's name kept with them (link.test.ts)
 * - a stop sent to the server without its reason (it refuses one, 1 to 200
 *   characters), or with one that does not name this computer: since
 *   2026-11-03 the window asks no reason, a stop is one click
 */

const SERVER_ID = 'd795d0ff4d5d8e50';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';
const HOST_SOCKET = '/home/ubuntu/tars-cloud/home/.tars-private/door.sock';
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9vZGJ5ZQ';
const UP = { running: true, door: '/home/tars/.tars-private/door.sock', serverId: SERVER_ID, name: 'srv1539916' };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cloud-ipc-'));
  const file = path.join(dir, 'cloud-link.json');
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: Array<[string, unknown]> = [];
  const runs: ServerCommand[] = [];
  const forwards: string[] = [];
  const timers: number[] = [];
  const drives: Array<[string, string, Record<string, unknown>]> = [];
  const answers: Partial<Record<ServerCommand['do'], RunResult>> = {
    status: { ok: true, json: UP },
    'clients-add': { ok: true, json: { id: 'c_10eafeea', credential: CREDENTIAL, serverId: SERVER_ID } },
    'clients-list': { ok: true, json: { clients: [{ id: 'c_10eafeea', name: 'PC (desktop)', kind: 'desktop', scopes: ['see', 'drive'], createdAt: '2026-11-03T00:00:00.000Z', hash: 'ab12', key: HOST_KEY }] } },
    'clients-revoke': { ok: true, json: { revoked: true } },
  };
  const door: DoorClient = {
    hello: async () => ({ ok: true, serverId: SERVER_ID }),
    fleet: async () => ({ status: 200, body: { youMay: ['see', 'drive'], agents: [{ agentId: 'a1', name: 'Nova', status: 'running', projectPath: '/home/tars/code/tars', cliRunning: true }] } }),
    screen: async () => ({ status: 200, body: { screen: 'NOVA', cliRunning: true } }),
    drive: async (agentId, action, body) => { drives.push([agentId, action, body]); return { status: 200, body: { ok: true } }; },
    stream: () => ({ close: () => {} }),
  };
  const service = registerCloudHandlers({
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    broadcast: (channel, payload) => { sent.push([channel, payload]); },
    file,
    forwardDir: path.join(dir, 'cloud'),
    hostname: () => 'PC-Nicolas',
    run: async (_profile, command) => { runs.push(command); return answers[command.do] ?? { ok: false, problem: 'failed', detail: '' }; },
    forward: (_profile, remoteSocket) => {
      forwards.push(remoteSocket);
      return { end: { kind: 'tcp', port: 47117 }, ready: Promise.resolve(), ended: new Promise(() => {}), close: () => {} };
    },
    doorClient: () => door,
    every: (_fn, ms) => { timers.push(ms); return () => {}; },
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  };
  return { file, call, sent, runs, forwards, timers, service, handlers, answers, drives };
}

const docker = { host: 'ubuntu@203.0.113.10', runner: { kind: 'docker', container: 'tars-server', sudo: true }, doorSocket: HOST_SOCKET };

describe('the direct test route', () => {
  it('only an unpackaged app reads TARS_CLOUD_DIRECT', () => {
    expect(directRoute({ TARS_CLOUD_DIRECT: HOST_SOCKET }, false)).toBe(HOST_SOCKET);
    expect(directRoute({ TARS_CLOUD_DIRECT: HOST_SOCKET }, true)).toBeNull();
    expect(directRoute({}, false)).toBeNull();
  });
});

describe('window.electronAPI.cloud', () => {
  it('off by default, no ssh', async () => {
    const t = setup();
    await t.service.start();
    expect(await t.call('cloud:list')).toEqual([]);
    expect(await t.call('cloud:agents')).toEqual([]);
    expect(t.runs).toEqual([]);
    expect(t.forwards).toEqual([]);
    expect(t.timers).toEqual([]);
  });

  it('a window call with an id of another shape is refused before the link, the fleet or ssh', async () => {
    const t = setup();
    const saved = await t.call('cloud:save', docker) as { success: true; id: string };
    for (const id of ['a1', '../x', 's_1a2b3c4d; ls', 42]) {
      expect(await t.call('cloud:connect', id), String(id)).toMatchObject({ success: false });
      expect(await t.call('cloud:clients', id), String(id)).toMatchObject({ success: false });
    }
    expect(await t.call('cloud:revoke', saved.id, 'c_10eafeea; rm -rf ~')).toMatchObject({ success: false });
    for (const remoteId of ['a1', 'm:m-aaaaaaaaaaaaaaaa:a1', `c:${SERVER_ID}:a/b`, null]) {
      expect(await t.call('cloud:drive', remoteId, 'stop', { reason: 'x' }), String(remoteId)).toMatchObject({ success: false });
      expect(await t.call('cloud:keys', remoteId, 'ls'), String(remoteId)).toMatchObject({ success: false });
      expect(await t.call('cloud:screen', remoteId)).toBeNull();
    }
    expect(await t.call('cloud:drive', `c:${SERVER_ID}:a1`, 'delete', {})).toMatchObject({ success: false });
    expect(t.runs).toEqual([]);
  });

  it('the window cannot set a credential, a server id or a host under a credential', async () => {
    const t = setup();
    const saved = await t.call('cloud:save', { ...docker, credential: CREDENTIAL, serverId: 'aaaaaaaaaaaaaaaa', clientId: 'c_00000000' }) as { success: true; id: string };
    expect(readLink(t.file).servers).toEqual([{ id: saved.id, ...docker }]);
    await t.call('cloud:connect', saved.id);
    expect(await t.call('cloud:save', { ...docker, id: saved.id, host: 'evil@203.0.113.9' })).toMatchObject({ success: false });
    expect(await t.call('cloud:save', { ...docker, id: saved.id, runner: { kind: 'docker', container: 'tars-2', sudo: false } })).toEqual({ success: true, id: saved.id });
    expect(readLink(t.file).servers[0]).toMatchObject({ host: docker.host, credential: CREDENTIAL, runner: { container: 'tars-2' } });
  });

  it("the server's clients reach the window as they show: no control or format character, a few scopes", async () => {
    const t = setup();
    const RLO = String.fromCharCode(0x202e);
    const BEL = String.fromCharCode(7);
    t.answers['clients-list'] = { ok: true, json: { clients: [{
      id: 'c_10eafeea', name: `PC${RLO}-Nicolas\nevil${BEL}`, kind: `desk${BEL}top`, scopes: [...Array(40)].map((_, i) => `s${i}${RLO}`),
      createdAt: '2026-11-03T00:00:00.000Z', mintedVia: `ssh${RLO} from 100.64.0.9`,
    }] } };
    const saved = await t.call('cloud:save', docker) as { success: true; id: string };
    const answer = await t.call('cloud:clients', saved.id) as { success: true; clients: Array<Record<string, unknown>> };
    expect(answer.clients[0]).toMatchObject({ name: 'PC-Nicolas evil', kind: 'desktop', mintedVia: 'ssh from 100.64.0.9' });
    expect(answer.clients[0].scopes).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
  });

  it('nothing sent to the window holds the credential, the socket path or a host key', async () => {
    const t = setup();
    const saved = await t.call('cloud:save', docker) as { success: true; id: string };
    expect(await t.call('cloud:connect', saved.id)).toMatchObject({ success: true, state: { phase: 'connected' } });
    expect(t.timers).toHaveLength(1);
    await t.service.pollNow();
    const answers = [
      await t.call('cloud:list'),
      await t.call('cloud:agents'),
      await t.call('cloud:clients', saved.id),
      await t.call('cloud:screen', `c:${SERVER_ID}:a1`),
      await t.call('cloud:drive', `c:${SERVER_ID}:a1`, 'stop', { reason: 'done' }),
      await t.call('cloud:revoke', saved.id, 'c_10eafeea'),
    ];
    expect(answers[1]).toMatchObject([{ id: `c:${SERVER_ID}:a1`, name: 'Nova' }]);
    expect(answers[2]).toEqual({ success: true, clients: [{ id: 'c_10eafeea', name: 'PC (desktop)', kind: 'desktop', scopes: ['see', 'drive'], createdAt: '2026-11-03T00:00:00.000Z' }] });
    const seen = JSON.stringify([answers, t.sent]);
    for (const secret of [CREDENTIAL, HOST_SOCKET, HOST_KEY, 'ab12']) expect(seen.includes(secret), secret).toBe(false);
    expect(t.sent.map(([channel]) => channel)).toEqual(expect.arrayContaining(['cloud:state', 'cloud:agents']));
  });

  it('a stop from the window asks no reason: the server is sent one that names this computer', async () => {
    const t = setup();
    const saved = await t.call('cloud:save', docker) as { success: true; id: string };
    await t.call('cloud:connect', saved.id);
    await t.service.pollNow();
    expect(await t.call('cloud:drive', `c:${SERVER_ID}:a1`, 'stop', {})).toMatchObject({ success: true });
    expect(await t.call('cloud:drive', `c:${SERVER_ID}:a1`, 'stop', { reason: '' })).toMatchObject({ success: true });
    const stops = t.drives.filter(([, action]) => action === 'stop');
    expect(stops).toEqual([['a1', 'stop', { reason: 'Stopped from PC-Nicolas' }], ['a1', 'stop', { reason: 'Stopped from PC-Nicolas' }]]);
  });
});
