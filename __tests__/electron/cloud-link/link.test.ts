import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCloudLink, retryDelay, type LinkForward } from '../../../electron/services/cloud-link/link';
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
 * - the server's name kept with characters nobody sees (a right-to-left
 *   override making it look like another), shown on every badge and line
 *
 * The link, part 2: the retry owner (Task 6, Review Focus 3).
 *
 * How it fails:
 * - two Connects at once, or a Connect during a backoff, opening two forwards
 * - the forward ending (sleep, Wi-Fi gone, keep-alive silence) read as still
 *   connected, or as failed with no retry
 * - a retry loop with no backoff, a backoff past 5 min, no jitter (every
 *   desktop retrying in step), or one that never comes back down after a link
 *   that held for a minute
 * - retrying past a problem only the user can fix (a host key, a key, sudo,
 *   another server), or minting again on a retry
 * - a 401 from the door (credential revoked) read as offline and retried
 * - Disconnect during a backoff leaving the retry armed
 * - quitting (or a dropped link) sending the server anything, or leaving a
 *   local `ssh` running
 */

const SERVER_ID = 'd795d0ff4d5d8e50';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';
const HOST_SOCKET = '/home/ubuntu/tars-cloud/home/.tars-private/door.sock';
const UP = { running: true, pid: 7, apiPort: 31415, version: '2.0.4', door: '/home/tars/.tars-private/door.sock', serverId: SERVER_ID, name: 'srv1539916' };
const MINTED = { id: 'c_10eafeea', credential: CREDENTIAL, serverId: SERVER_ID };

type Call = { command: ServerCommand; stdin?: object };

type Timer = { fn: () => void; ms: number; cancelled: boolean };

function setup(answers: Partial<Record<ServerCommand['do'], RunResult[]>>, over: Partial<ServerProfile> = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-link-')), 'cloud-link.json');
  const profile: ServerProfile = {
    id: 's_1a2b3c4d', host: 'ubuntu@100.101.245.29', runner: { kind: 'docker', container: 'tars-server', sudo: true }, doorSocket: HOST_SOCKET, ...over,
  };
  saveProfile(file, profile);
  const calls: Call[] = [];
  const forwards: Array<{ remoteSocket: string; closed: boolean; drop: () => void }> = [];
  const timers: Timer[] = [];
  const clock = { now: 0, random: 1 };
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
      let drop!: () => void;
      const ended = new Promise<{ code: number | null; stderr: string }>(resolve => { drop = () => resolve({ code: 255, stderr: 'Timeout, server not responding.' }); });
      const record = { remoteSocket, closed: false, drop };
      forwards.push(record);
      return { end: { kind: 'tcp', port: 47117 }, ready: Promise.resolve(), ended, close: () => { record.closed = true; drop(); } };
    },
    client: () => ({ hello: async () => ({ ok: true, serverId: SERVER_ID }) }),
    now: () => clock.now,
    later: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    random: () => clock.random,
  });
  const did = () => calls.map(c => c.command.do);
  const pending = () => timers.filter(t => !t.cancelled);
  /** Fires the one armed retry and lets the attempt it starts settle. */
  const fire = async () => {
    const armed = pending();
    expect(armed).toHaveLength(1);
    armed[0].cancelled = true;
    armed[0].fn();
    await settle();
  };
  return { file, profile, link, calls, forwards, did, timers, pending, fire, clock };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

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
    expect(t.calls[1]).toEqual({ command: { do: 'clients-add' }, stdin: { name: 'PC-Nicolas', kind: 'desktop', scopes: ['see', 'drive'] } });
    expect(readLink(t.file).servers[0]).toMatchObject({ serverId: SERVER_ID, name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL });
    t.link.disconnect(t.profile.id);
    await t.link.connect(t.profile.id);
    expect(t.did().filter(d => d === 'clients-add')).toHaveLength(1);
  });

  it("keeps the server's name as it shows: no control or format character, one line", async () => {
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const t = setup({ status: [ok({ ...UP, name: `srv${RLO}61935${ZWSP}15\n1\u0007` })], 'clients-add': [ok(MINTED)] });
    await t.link.connect(t.profile.id);
    expect(readLink(t.file).servers[0].name).toBe('srv6193515 1');
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

describe('the retry owner', () => {
  const linked = { serverId: SERVER_ID, name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL };
  const unreachable: RunResult = { ok: false, problem: 'unreachable', detail: 'ssh: connect to host 100.101.245.29 port 22: Network is unreachable' };

  it('one forward per server at most', async () => {
    const t = setup({ status: [ok(UP)] }, linked);
    await Promise.all([t.link.connect(t.profile.id), t.link.connect(t.profile.id)]);
    expect(t.forwards).toHaveLength(1);
    t.forwards[0].drop();
    await settle();
    expect(t.pending()).toHaveLength(1);
    // Reconnect pressed during the backoff: one attempt now, the armed retry gone.
    await t.link.connect(t.profile.id);
    expect(t.pending()).toHaveLength(0);
    expect(t.forwards).toHaveLength(2);
    expect(t.link.state(t.profile.id).phase).toBe('connected');
    await t.link.connect(t.profile.id);
    expect(t.forwards).toHaveLength(2);
  });

  it('a dropped link is offline at once, and comes back by itself without a new mint', async () => {
    const t = setup({ status: [ok(UP)] }, linked);
    await t.link.connect(t.profile.id);
    t.clock.now = 5_000;
    t.forwards[0].drop();
    await settle();
    expect(t.link.state(t.profile.id)).toEqual({ phase: 'offline', since: new Date(5_000).toISOString() });
    await t.fire();
    expect(t.link.state(t.profile.id).phase).toBe('connected');
    expect(t.forwards).toHaveLength(2);
    expect(t.did()).toEqual(['status', 'status']);
  });

  it('backoff is jittered and capped at 5 min', async () => {
    for (let n = 0; n < 16; n++) {
      const base = Math.min(2_000 * 2 ** n, 300_000);
      expect(retryDelay(n, () => 0), `n=${n}`).toBe(base / 2);
      expect(retryDelay(n, () => 1), `n=${n}`).toBe(base);
    }
    const t = setup({ status: [ok(UP), ...Array(10).fill(unreachable)] }, linked);
    await t.link.connect(t.profile.id);
    t.forwards[0].drop();
    await settle();
    const since = t.link.state(t.profile.id).since;
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      delays.push(t.pending()[0].ms);
      await t.fire();
      expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'offline', since, problem: 'unreachable' });
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
  });

  it('a link that held for a minute starts its backoff over', async () => {
    const t = setup({ status: [ok(UP), unreachable, unreachable, ok(UP)] }, linked);
    await t.link.connect(t.profile.id);
    t.forwards[0].drop();
    await settle();
    await t.fire();
    await t.fire();
    await t.fire();
    expect(t.link.state(t.profile.id).phase).toBe('connected');
    const upAt = t.clock.now;
    t.clock.now = upAt + 59_000;
    t.forwards[1].drop();
    await settle();
    expect(t.pending()[0].ms).toBe(16_000);
    const t2 = setup({ status: [ok(UP), unreachable, ok(UP)] }, linked);
    await t2.link.connect(t2.profile.id);
    t2.forwards[0].drop();
    await settle();
    await t2.fire();
    await t2.fire();
    t2.clock.now = 60_000;
    t2.forwards[1].drop();
    await settle();
    expect(t2.pending()[0].ms).toBe(2_000);
  });

  it('stops retrying at a problem only the user can fix', async () => {
    const t = setup({ status: [ok(UP), { ok: false, problem: 'host-key-changed', detail: 'REMOTE HOST IDENTIFICATION HAS CHANGED!' }] }, linked);
    await t.link.connect(t.profile.id);
    t.forwards[0].drop();
    await settle();
    await t.fire();
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'failed', problem: 'host-key-changed', sentence: problemSentence('host-key-changed', t.profile.host) });
    expect(t.pending()).toHaveLength(0);
  });

  it('a 401 reads as disconnected, not offline', async () => {
    const t = setup({ status: [ok(UP)] }, linked);
    await t.link.connect(t.profile.id);
    t.link.refused(t.profile.id);
    await settle();
    expect(t.link.state(t.profile.id)).toMatchObject({ phase: 'disconnected', sentence: expect.stringMatching(/refused this computer's credential/) });
    expect(t.forwards[0].closed).toBe(true);
    expect(t.pending()).toHaveLength(0);
    expect(t.did()).toEqual(['status']);
  });

  it('Disconnect during a backoff cancels it', async () => {
    const t = setup({ status: [ok(UP)] }, linked);
    await t.link.connect(t.profile.id);
    t.forwards[0].drop();
    await settle();
    expect(t.pending()).toHaveLength(1);
    t.link.disconnect(t.profile.id);
    expect(t.pending()).toHaveLength(0);
    expect(t.link.state(t.profile.id).phase).toBe('off');
  });

  it('a dropped link stops nothing on the server', async () => {
    const t = setup({ status: [ok(UP)] }, linked);
    const other = { ...t.profile, id: 's_5e6f7a8b' };
    saveProfile(t.file, other);
    await t.link.connect(t.profile.id);
    await t.link.connect(other.id);
    t.forwards[0].drop();
    await settle();
    t.link.closeAll();
    await settle();
    expect(t.forwards[1].closed).toBe(true);
    expect(t.pending()).toHaveLength(0);
    expect(t.did()).toEqual(['status', 'status']);
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
