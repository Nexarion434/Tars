import { describe, it, expect, beforeEach } from 'vitest';
import { createRemoteFleet, parseCloudId, type CloudServer, type RemoteFleetDeps } from '../../../electron/services/cloud-link/remote-fleet';
import type { DoorAnswer, DoorClient, StreamEnd } from '../../../electron/services/cloud-link/client';
import { MAX_KEYS } from '../../../electron/services/cloud/drive';

/**
 * A Tars server's agents as the desktop keeps them between polls, their live
 * output and the typing queue (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 8).
 * Ported from win/machines' remote-fleet.test.ts; its failures kept, for
 * connected servers instead of paired machines:
 * 1. a server's agents not under `c:<serverId>:<agentId>` with its name, a
 *    field the door did not share kept, a bad agent id let through
 * 2. a server that stops answering (or whose link is down) loses its agents, is
 *    not marked offline, or its "offline since" moves at every poll; back, it
 *    stays offline
 * 3. a server forgotten here keeps its agents on screen, or its watched streams open
 * 4. the window told at every poll, changed or not
 * 5. two panes on one agent opening two streams; chunks under another id; the
 *    last unwatch leaving the stream open; a watch of a local id opening one
 * 6. a stream that ends under a watching pane never opened again, or opened
 *    twice; opened again, what the pane missed lost (its screen comes first)
 * 7. one server not answering holding the others' poll
 * 8. drivable when the server's fleet does not say `drive`, or still once it
 *    stops answering
 * 9. an action sent to another server or for an id that is not remote; the
 *    server's sentence lost or shown with characters nobody sees; no answer
 *    read as done, a start that may have run read as not run
 * 10. keys out of order, one request per key while one is on its way, a burst
 *    past MAX_KEYS sent whole, a character cut in two, a failure leaving the
 *    queue stuck
 * Added in M2:
 * 11. two polls at once making two fleet requests to a server
 * 12. a 401 (on a poll, a drive or a stream) read as offline and retried
 *    instead of told to the link, which disconnects; a disconnected server read
 *    as offline
 * 13. a stream the door ended for a revoke opened again
 * 14. keys that keep going after the first failure of their burst
 * 15. an outside-agent ceiling on keys (the door's 403) not read as the server's sentence
 * 16. a watched pane whose stream ended while its server was offline never
 *    opened again once the server is back, or opened more than once
 */

const VPS: CloudServer = { id: 's_1a2b3c4d', serverId: 'd795d0ff4d5d8e50', name: 'srv1539916' };
const BOX: CloudServer = { id: 's_5e6f7a8b', serverId: 'aaaaaaaaaaaaaaaa', name: 'box' };
const NO_ANSWER: DoorAnswer = { status: 0, body: {} };

let servers: CloudServer[];
let phases: Map<string, 'connected' | 'offline' | 'disconnected'>;
let answers: Map<string, DoorAnswer | 'hang'>;
let fleetCalls: number;
let fleets: unknown[][];
let outputs: Array<[string, string]>;
let opened: Array<{ server: string; agentId: string; onChunk: (c: string) => void; onEnd: (how: StreamEnd) => void; closed: boolean }>;
let driven: Array<[string, string, string, Record<string, unknown>]>;
let driveAnswers: DoorAnswer[];
let refused: string[];
let clock: number;
let timers: Array<{ at: number; fn: () => void }>;

function clientOf(server: CloudServer): DoorClient {
  return {
    hello: async () => ({ ok: true, serverId: server.serverId }),
    fleet: () => {
      fleetCalls++;
      const a = answers.get(server.id);
      return a === 'hang' ? new Promise(() => {}) : Promise.resolve(a ?? NO_ANSWER);
    },
    screen: async agentId => ({ status: 200, body: { screen: `${server.name}:${agentId}`, cliRunning: true } }),
    drive: async (agentId, action, body) => {
      driven.push([server.id, agentId, action, body]);
      return driveAnswers.length > 1 ? driveAnswers.shift()! : driveAnswers[0];
    },
    stream: (agentId, onChunk, onEnd) => {
      const s = { server: server.id, agentId, onChunk, onEnd, closed: false };
      opened.push(s);
      return { close: () => { s.closed = true; } };
    },
  };
}

function deps(): RemoteFleetDeps {
  return {
    servers: () => servers,
    link: server => {
      const phase = phases.get(server.id) ?? 'connected';
      return phase === 'connected' ? { client: clientOf(server) } : { phase };
    },
    refused: id => { refused.push(id); },
    onFleet: agents => { fleets.push(agents); },
    onOutput: (id, chunk) => { outputs.push([id, chunk]); },
    now: () => clock,
    later: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
    retryMs: 3_000,
    pollTimeoutMs: 200,
  };
}
const runTimers = () => { const due = timers.filter(t => t.at <= clock); timers = timers.filter(t => t.at > clock); due.forEach(t => t.fn()); };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const fleetOf = (ids: string[], youMay = ['see', 'drive']): DoorAnswer => ({
  status: 200,
  body: { v: 1, youMay, agents: ids.map(id => ({ agentId: id, name: `Agent ${id}`, status: 'running', projectPath: '/home/tars/code/tars', cliRunning: true })) },
});
const rid = (server: CloudServer, agentId: string) => `c:${server.serverId}:${agentId}`;

beforeEach(() => {
  servers = [VPS];
  phases = new Map();
  answers = new Map([[VPS.id, fleetOf(['a1', 'a2'])]]);
  fleetCalls = 0;
  fleets = [];
  outputs = [];
  opened = [];
  driven = [];
  driveAnswers = [{ status: 200, body: { ok: true } }];
  refused = [];
  clock = Date.parse('2026-11-03T02:00:00.000Z');
  timers = [];
});

describe("a server's agents", () => {
  it('1. a server that answers shows its agents under its ids and its name, as the door shared them', async () => {
    answers.set(VPS.id, { status: 200, body: { youMay: ['see'], agents: [
      { agentId: 'a1', name: 'Nova', status: 'running', projectPath: '/home/tars/code/tars', cliRunning: true, token: 'never kept' },
      { agentId: '../x', name: 'bad' },
    ] } });
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    expect(fleet.list()).toEqual([{
      id: rid(VPS, 'a1'), agentId: 'a1', name: 'Nova', status: 'running', projectName: 'tars', projectPath: '/home/tars/code/tars', cliRunning: true,
      server: { id: VPS.id, serverId: VPS.serverId, name: 'srv1539916', status: 'connected', drive: false },
    }]);
    expect(parseCloudId(rid(VPS, 'a1'))).toEqual({ serverId: VPS.serverId, agentId: 'a1' });
    for (const id of ['a1', 'm:m-aaaaaaaaaaaaaaaa:a1', 'c:short:a1', `c:${VPS.serverId}:a/b`]) expect(parseCloudId(id), id).toBeNull();
  });

  it('2. a server gone quiet keeps its agents, offline since its first missed poll, and comes back', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    answers.set(VPS.id, NO_ANSWER);
    clock += 3_000;
    await fleet.poll();
    const since = new Date(clock).toISOString();
    expect(fleet.list().map(a => a.server)).toEqual([0, 1].map(() => ({ id: VPS.id, serverId: VPS.serverId, name: 'srv1539916', status: 'offline', offlineSince: since, drive: false })));
    clock += 3_000;
    phases.set(VPS.id, 'offline');
    await fleet.poll();
    expect(fleet.list()[0].server.offlineSince).toBe(since);
    phases.delete(VPS.id);
    answers.set(VPS.id, fleetOf(['a1']));
    await fleet.poll();
    expect(fleet.list().map(a => [a.agentId, a.server.status, a.server.offlineSince, a.server.drive])).toEqual([['a1', 'connected', undefined, true]]);
  });

  it('3. a server forgotten here takes its agents and its watched streams with it', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    servers = [];
    await fleet.poll();
    expect(fleet.list()).toEqual([]);
    expect(opened.map(s => s.closed)).toEqual([true]);
  });

  it('4. the window is told when the list moves, not at every poll', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    await fleet.poll();
    expect(fleets).toHaveLength(1);
    answers.set(VPS.id, NO_ANSWER);
    await fleet.poll();
    expect(fleets).toHaveLength(2);
  });

  it('7 and 11. one server not answering holds no other, and two polls make one request each', async () => {
    servers = [VPS, BOX];
    answers.set(VPS.id, 'hang');
    answers.set(BOX.id, fleetOf(['b1']));
    const fleet = createRemoteFleet(deps());
    const first = fleet.poll();
    const second = fleet.poll();
    expect(second).toBe(first);
    await first;
    expect(fleetCalls).toBe(2);
    expect(fleet.list().map(a => [a.id, a.server.status])).toEqual([[rid(BOX, 'b1'), 'connected']]);
  });

  it('12. a 401 on a poll is told to the link and reads as disconnected; a disconnected link stays so', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    answers.set(VPS.id, { status: 401, body: { error: 'Not a client of this Tars server, or no longer one.' } });
    await fleet.poll();
    expect(refused).toEqual([VPS.id]);
    expect(fleet.list()[0].server).toMatchObject({ status: 'disconnected', drive: false });
    phases.set(VPS.id, 'disconnected');
    await fleet.poll();
    expect(fleet.list()[0].server.status).toBe('disconnected');
    expect(refused).toEqual([VPS.id]);
  });
});

describe('watching', () => {
  it('5. two panes share one stream, chunks under the remote id, closed with the last pane', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    fleet.watch(rid(VPS, 'a1'));
    fleet.watch('a1');
    fleet.watch(rid(BOX, 'a1'));
    expect(opened.map(s => [s.server, s.agentId])).toEqual([[VPS.id, 'a1']]);
    opened[0].onChunk('hello');
    expect(outputs).toEqual([[rid(VPS, 'a1'), 'hello']]);
    fleet.unwatch(rid(VPS, 'a1'));
    expect(opened[0].closed).toBe(false);
    fleet.unwatch(rid(VPS, 'a1'));
    expect(opened[0].closed).toBe(true);
  });

  it('6. a stream ended under a watching pane opens once again, its screen first', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    opened[0].onEnd({ reason: 'dropped' });
    opened[0].onEnd({ reason: 'dropped' });
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    opened[1].onChunk('after');
    await settle();
    expect(outputs).toEqual([[rid(VPS, 'a1'), 'srv1539916:a1'], [rid(VPS, 'a1'), 'after']]);
    fleet.unwatch(rid(VPS, 'a1'));
    opened[1].onEnd({ reason: 'closed' });
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
  });

  it('16. reattaches a watched pane once after offline', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    phases.set(VPS.id, 'offline');
    opened[0].onEnd({ reason: 'dropped' });
    for (let i = 0; i < 3; i++) { clock += 3_000; runTimers(); }
    expect(opened).toHaveLength(1);
    phases.delete(VPS.id);
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    for (let i = 0; i < 3; i++) { clock += 3_000; runTimers(); }
    expect(opened).toHaveLength(2);
    await settle();
    expect(outputs).toEqual([[rid(VPS, 'a1'), 'srv1539916:a1']]);
    // A pane closed while its server was away opens nothing when it is back.
    fleet.watch(rid(VPS, 'a2'));
    phases.set(VPS.id, 'offline');
    opened[2].onEnd({ reason: 'dropped' });
    fleet.unwatch(rid(VPS, 'a2'));
    phases.delete(VPS.id);
    for (let i = 0; i < 3; i++) { clock += 3_000; runTimers(); }
    expect(opened).toHaveLength(3);
  });

  it('16. a stream refused while its server comes back up (not a 401) is opened again', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    opened[0].onEnd({ reason: 'refused', status: 404 });
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    expect(refused).toEqual([]);
  });

  it('12 and 13. a stream the door ended for a revoke, or refused 401, is told to the link and not opened again', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch(rid(VPS, 'a1'));
    opened[0].onEnd({ reason: 'revoked' });
    fleet.watch(rid(VPS, 'a2'));
    opened[1].onEnd({ reason: 'refused', status: 401 });
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    expect(refused).toEqual([VPS.id, VPS.id]);
  });
});

describe('driving', () => {
  it('8 and 9. an action goes to its server and agent; the sentence comes back clean', async () => {
    servers = [VPS, BOX];
    const fleet = createRemoteFleet(deps());
    expect(await fleet.drive(rid(BOX, 'b1'), 'stop', { reason: 'done' })).toEqual({ success: true });
    expect(driven).toEqual([[BOX.id, 'b1', 'stop', { reason: 'done' }]]);
    const RLO = String.fromCharCode(0x202e);
    driveAnswers = [{ status: 409, body: { error: `It is\nalready ${RLO}running.` } }];
    expect(await fleet.drive(rid(VPS, 'a1'), 'start', {})).toEqual({ success: false, error: 'It is already running.' });
    driveAnswers = [NO_ANSWER];
    expect(await fleet.drive(rid(VPS, 'a1'), 'start', {})).toEqual({ success: false, error: 'srv1539916 did not answer in time. The agent may have started anyway.' });
    expect(await fleet.drive(rid(VPS, 'a1'), 'message', { text: 'hi' })).toEqual({ success: false, error: 'srv1539916 did not answer.' });
    expect(await fleet.drive('a1', 'stop', {})).toEqual({ success: false, error: 'There is no such agent.' });
    phases.set(VPS.id, 'offline');
    expect(await fleet.drive(rid(VPS, 'a1'), 'stop', {})).toEqual({ success: false, error: 'srv1539916 is not connected.' });
    expect(driven).toHaveLength(4);
  });

  it('12. a 401 on a drive is told to the link', async () => {
    driveAnswers = [{ status: 401, body: { error: 'Not a client of this Tars server, or no longer one.' } }];
    const fleet = createRemoteFleet(deps());
    expect(await fleet.drive(rid(VPS, 'a1'), 'stop', {})).toEqual({ success: false, error: 'Not a client of this Tars server, or no longer one.' });
    expect(refused).toEqual([VPS.id]);
  });

  it('10. keys keep their order, gather behind the batch on its way, and split at MAX_KEYS whole characters', async () => {
    const fleet = createRemoteFleet(deps());
    const first = fleet.keys(rid(VPS, 'a1'), 'l');
    const second = fleet.keys(rid(VPS, 'a1'), 's');
    const third = fleet.keys(rid(VPS, 'a1'), '\r');
    expect(await Promise.all([first, second, third])).toEqual([0, 1, 2].map(() => ({ success: true })));
    expect(driven.map(d => d[3].data)).toEqual(['l', 's\r']);
    driven = [];
    const smile = String.fromCodePoint(0x1f600);
    await fleet.keys(rid(VPS, 'a1'), 'x'.repeat(MAX_KEYS - 1) + smile + 'y');
    expect(driven.map(d => (d[3].data as string).length)).toEqual([MAX_KEYS - 1, 3]);
  });

  it('14 and 15. a burst stops at its first failure, with the server sentence, and later keys still go', async () => {
    const fleet = createRemoteFleet(deps());
    const ceiling = 'srv1539916 does not let Hermes type into its terminals.';
    driveAnswers = [{ status: 200, body: { ok: true } }, { status: 403, body: { error: ceiling } }, { status: 200, body: { ok: true } }];
    const burst = await fleet.keys(rid(VPS, 'a1'), 'x'.repeat(MAX_KEYS * 3));
    expect(burst).toEqual({ success: false, error: ceiling });
    expect(driven).toHaveLength(2);
    expect(await fleet.keys(rid(VPS, 'a1'), 'z')).toEqual({ success: true });
    expect(driven).toHaveLength(3);
  });

  it('a pane size goes to its agent as size', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.resize(rid(VPS, 'a1'), 120, 40);
    expect(driven).toEqual([[VPS.id, 'a1', 'size', { cols: 120, rows: 40 }]]);
    expect(await fleet.screen(rid(VPS, 'a1'))).toEqual({ screen: 'srv1539916:a1', cliRunning: true });
  });
});
