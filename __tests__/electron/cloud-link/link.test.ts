import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCloudLink, type LinkForward } from '../../../electron/services/cloud-link/link';
import { readLink, saveProfile, type ServerProfile } from '../../../electron/services/cloud-link/store';
import { problemSentence, type RunResult, type RunOptions } from '../../../electron/services/cloud-link/remote-run';
import type { ServerCommand } from '../../../electron/services/cloud-link/ssh';

/**
 * The link, part 1: status, start if down, mint once (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 4).
 *
 * How it fails:
 * - a server that is down started in a loop, or never started: status, start,
 *   status again, once, and a server still down is a failure
 * - a stopped container read as a broken server instead of one to start
 * - `start` failing without its sentence (sudo wanting a password)
 * - a mint answer without `id`, `credential` or `serverId` saved anyway, or one
 *   whose `serverId` is not the one `status` named
 * - a server whose id changed since the last connect admitted, minted on, or
 *   forwarded to (Review Focus 4)
 * - the desktop minting again on a reconnect, or naming itself so that
 *   `clients list` cannot tell the desktops apart (Review Focus 2)
 * - Forget leaving the profile when the server cannot be reached, or not
 *   saying the credential is still valid there
 * - the forward opened, or hello asked, before the checks above
 */

const SERVER_ID = 'd795d0ff4d5d8e50';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';
const HOST_SOCKET = '/home/ubuntu/tars-cloud/home/.tars-private/door.sock';
const UP = { running: true, pid: 7, apiPort: 31415, version: '2.0.4', door: '/home/tars/.tars-private/door.sock', serverId: SERVER_ID, name: 'srv1539916' };
const MINTED = { id: 'c_10eafeea', credential: CREDENTIAL, serverId: SERVER_ID };

type Call = { command: ServerCommand; stdin?: object };

function setup(answers: Partial<Record<ServerCommand['do'], RunResult[]>>, over: Partial<ServerProfile> = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-link-')), 'cloud-link.json');
  const profile: ServerProfile = {
    id: 's_1a2b3c4d', host: 'ubuntu@100.101.245.29', runner: { kind: 'docker', container: 'tars-server', sudo: true }, doorSocket: HOST_SOCKET, ...over,
  };
  saveProfile(file, profile);
  const calls: Call[] = [];
  const forwards: Array<{ remoteSocket: string; closed: boolean }> = [];
  const run = async (_p: { host: string }, command: ServerCommand, opts?: RunOptions): Promise<RunResult> => {
    calls.push({ command, ...(opts?.stdin ? { stdin: opts.stdin } : {}) });
    const queue = answers[command.do];
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    return next ?? { ok: false, problem: 'failed', detail: `no answer for ${command.do}` };
  };
  const link = createCloudLink({
    file,
    run,
    hostname: () => 'PC-Nicolas',
    forward: (_p, remoteSocket): LinkForward => {
      const record = { remoteSocket, closed: false };
      forwards.push(record);
      return { end: { kind: 'tcp', port: 47117 }, ready: Promise.resolve(), ended: new Promise(() => {}), close: () => { record.closed = true; } };
    },
    client: () => ({ hello: async () => ({ ok: true, serverId: SERVER_ID }) }),
  });
  const did = () => calls.map(c => c.command.do);
  return { file, profile, link, calls, forwards, did };
}

const ok = (json: Record<string, unknown>): RunResult => ({ ok: true, json });

describe('connect: status, start if down', () => {
  it('starts a server that is down, once', async () => {
    const t = setup({ status: [ok({ running: false, serverId: SERVER_ID, name: 'srv1539916' }), ok(UP)], start: [ok({})], 'clients-add': [ok(MINTED)] });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status', 'start', 'status', 'clients-add']);
    expect(t.link.state(t.profile.id).phase).toBe('connected');
  });

  it('a stopped container is a server to start', async () => {
    const t = setup({ status: [{ ok: false, problem: 'container-stopped', detail: '' }, ok(UP)], start: [ok({})], 'clients-add': [ok(MINTED)] });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status', 'start', 'status', 'clients-add']);
    expect(t.link.state(t.profile.id).phase).toBe('connected');
  });

  it('a server still down after start is a failure, not a loop', async () => {
    const t = setup({ status: [ok({ running: false, serverId: SERVER_ID })], start: [ok({})] });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status', 'start', 'status']);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'not-started' });
    expect(t.forwards).toEqual([]);
  });

  it('start failing names its sentence', async () => {
    const t = setup({ status: [{ ok: false, problem: 'container-stopped', detail: '' }], start: [{ ok: false, problem: 'sudo-password', detail: 'sudo: a password is required' }] });
    await t.link.connect(t.profile.id);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'sudo-password', sentence: problemSentence('sudo-password', t.profile.host) });
  });

  it("ssh's own failure on status names its sentence, and starts nothing", async () => {
    const t = setup({ status: [{ ok: false, problem: 'host-key-unknown', detail: 'Host key verification failed.' }] });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status']);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'host-key-unknown', sentence: problemSentence('host-key-unknown', t.profile.host) });
  });
});

describe('connect: mint once', () => {
  it("mints once with this machine's name", async () => {
    const t = setup({ status: [ok(UP)], 'clients-add': [ok(MINTED)] });
    await t.link.connect(t.profile.id);
    expect(t.calls[1]).toEqual({ command: { do: 'clients-add' }, stdin: { name: 'PC-Nicolas (desktop)', kind: 'desktop', scopes: ['see', 'drive'] } });
    expect(readLink(t.file).servers[0]).toMatchObject({ serverId: SERVER_ID, name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL });
    t.link.disconnect(t.profile.id);
    await t.link.connect(t.profile.id);
    expect(t.did().filter(d => d === 'clients-add')).toHaveLength(1);
  });

  it('a mint answer missing a field, or naming another server, is refused and nothing is saved', async () => {
    for (const answer of [{ credential: CREDENTIAL, serverId: SERVER_ID }, { id: 'c_10eafeea', serverId: SERVER_ID }, { id: 'c_10eafeea', credential: CREDENTIAL }, { ...MINTED, serverId: 'aaaaaaaaaaaaaaaa' }, { ...MINTED, credential: 'short' }]) {
      const t = setup({ status: [ok(UP)], 'clients-add': [ok(answer)] });
      await t.link.connect(t.profile.id);
      expect(t.link.state(t.profile.id).phase, JSON.stringify(answer)).toBe('failed');
      expect(readLink(t.file).servers[0], JSON.stringify(answer)).toEqual(t.profile);
      expect(t.forwards).toEqual([]);
    }
  });

  it('a server whose id changed is refused before any mint or forward', async () => {
    const t = setup({ status: [ok({ ...UP, serverId: 'aaaaaaaaaaaaaaaa' })], 'clients-add': [ok(MINTED)] }, { serverId: SERVER_ID, clientId: 'c_10eafeea', credential: CREDENTIAL });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status']);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'another-server' });
    expect(t.forwards).toEqual([]);
  });

  it('reconnecting reuses the credential', async () => {
    const t = setup({ status: [ok(UP)] }, { serverId: SERVER_ID, name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL });
    await t.link.connect(t.profile.id);
    expect(t.did()).toEqual(['status']);
    expect(t.link.state(t.profile.id).phase).toBe('connected');
  });

  it("forwards to the profile's socket for a docker runner, to the one status names otherwise", async () => {
    const docker = setup({ status: [ok(UP)], 'clients-add': [ok(MINTED)] });
    await docker.link.connect(docker.profile.id);
    expect(docker.forwards.map(f => f.remoteSocket)).toEqual([HOST_SOCKET]);
    const bare = setup({ status: [ok(UP)], 'clients-add': [ok(MINTED)] }, { runner: { kind: 'command', argv: ['node', '/srv/tars/electron/dist/server/cli.js'] }, doorSocket: undefined });
    await bare.link.connect(bare.profile.id);
    expect(bare.forwards.map(f => f.remoteSocket)).toEqual([UP.door]);
  });

  it('an unknown profile fails without ssh', async () => {
    const t = setup({});
    await t.link.connect('s_99999999');
    expect(t.calls).toEqual([]);
    expect(t.link.state('s_99999999').phase).toBe('failed');
  });
});

describe('forget', () => {
  it('forget revokes then clears', async () => {
    const t = setup({ status: [ok(UP)], 'clients-revoke': [ok({ revoked: true })] }, { serverId: SERVER_ID, clientId: 'c_10eafeea', credential: CREDENTIAL });
    await t.link.connect(t.profile.id);
    await t.link.forget(t.profile.id);
    expect(t.calls.at(-1)).toEqual({ command: { do: 'clients-revoke', id: 'c_10eafeea' } });
    expect(readLink(t.file).servers).toEqual([]);
    expect(t.forwards.every(f => f.closed)).toBe(true);
    expect(t.link.state(t.profile.id).phase).toBe('off');
  });

  it('clears the profile even when the revoke cannot reach the server, and says so', async () => {
    const t = setup({ 'clients-revoke': [{ ok: false, problem: 'unreachable', detail: '' }] }, { serverId: SERVER_ID, clientId: 'c_10eafeea', credential: CREDENTIAL });
    await t.link.forget(t.profile.id);
    expect(readLink(t.file).servers).toEqual([]);
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'off', problem: 'unreachable' });
    expect(t.link.state(t.profile.id).sentence).toMatch(/revoke/i);
  });
});

describe('onState', () => {
  it('tells each change, connecting first', async () => {
    const t = setup({ status: [ok(UP)], 'clients-add': [ok(MINTED)] });
    const seen: string[] = [];
    const off = t.link.onState((id, state) => seen.push(`${id}:${state.phase}`));
    await t.link.connect(t.profile.id);
    off();
    t.link.disconnect(t.profile.id);
    expect(seen).toEqual(['s_1a2b3c4d:connecting', 's_1a2b3c4d:connected']);
  });
});
