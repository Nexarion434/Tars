import { describe, it, expect, beforeEach } from 'vitest';
import { createRemoteFleet, type RemoteFleetDeps } from '../../../electron/services/machines/remote-fleet';
import { MAX_KEYS } from '../../../electron/services/machines/bridge-server';
import type { PairedMachine, RemoteAgent } from '../../../electron/services/machines/types';

/**
 * The other machines' agents as this one keeps them between polls, and their
 * live outputs. How it can fail, written before the code (2026-10-08):
 * 1. A machine that answers does not show its agents under its own remote
 *    ids and name.
 * 2. A machine that stops answering loses its agents (the panes go blank), or
 *    is not marked offline, or its "offline since" moves at every poll; back,
 *    it stays offline.
 * 3. A machine forgotten here keeps its agents on screen.
 * 4. The window is told at every poll, changed or not, or not told when a
 *    machine went offline.
 * 5. Two panes on one remote agent open two streams; its chunks reach the
 *    window under another id; the last unwatch leaves the stream open; a
 *    watch of a local id or of a machine not paired throws or opens one.
 * 6. A stream that ends while a pane watches is never opened again, or one
 *    nobody watches any more is.
 * 7. A screen is asked of the wrong machine, or for an id that is not remote.
 * 8. One machine that does not answer holds the others' poll.
 * And from the security review (2026-10-08):
 * 9. A retry scheduled for an ended stream opens a second stream on a newer
 *    watch of the same agent: every chunk written twice, one stream never closed.
 * 10. A stream opened again draws only what comes after it: what the pane
 *    missed while it was closed stays missed. Its screen comes first, and
 *    what arrived before the screen is not wiped by it.
 * 11. A machine forgotten here keeps its watched streams open.
 * And for driving (part 3, 2026-10-09):
 * 12. A machine reads as drivable when its fleet does not say it lets this
 *    one drive, or still does once it stops answering.
 * 14. Keys typed in a pane reach the other machine out of order, or one POST
 *    per key while one is on its way (a burst of typing becomes a burst of
 *    requests), or a refusal is lost.
 * 15. Keys gathered past MAX_KEYS (a long paste, typing behind a slow batch)
 *    go as one batch the other side refuses whole; or a batch that throws
 *    (the pairing file unreadable) leaves the queue stuck, every later key
 *    waiting for ever (security review, round 3).
 * 13. An action goes to another machine, or for an id that is not remote;
 *    the other machine's sentence is lost, or shown with characters nobody
 *    sees (bidi, zero width, controls); no answer reads as done, and a start
 *    that may have run reads as not run (security review of part 3).
 */

const PC: PairedMachine = { id: 'm-aaaaaaaaaaaaaaaa', name: 'PC', address: '100.88.0.1', port: 31418, inboundSecretHash: 'h', outboundSecret: 's', mayOnMe: 'see', pairedAt: '' };
const NAS: PairedMachine = { ...PC, id: 'm-bbbbbbbbbbbbbbbb', name: 'NAS' };

let peers: PairedMachine[];
let answers: Map<string, { status: number; body: Record<string, unknown> } | 'hang'>;
let fleets: RemoteAgent[][];
let outputs: Array<[string, string]>;
let opened: Array<{ peer: string; agentId: string; onChunk: (c: string) => void; onEnd: () => void; closed: boolean }>;
let clock: number;
let timers: Array<{ at: number; fn: () => void }>;
let driven: Array<[string, string, string, Record<string, unknown>]>;
let driveAnswer: { status: number; body: Record<string, unknown> };

function deps(): RemoteFleetDeps {
  return {
    peers: () => peers,
    fetchFleet: (peer) => {
      const a = answers.get(peer.id);
      return a === 'hang' ? new Promise(() => {}) : Promise.resolve(a ?? { status: 0, body: {} });
    },
    fetchScreen: async (peer, agentId) => ({ screen: `${peer.name}:${agentId}`, cliRunning: true }),
    openStream: (peer, agentId, onChunk, onEnd) => {
      const s = { peer: peer.id, agentId, onChunk, onEnd, closed: false };
      opened.push(s);
      return { close: () => { s.closed = true; } };
    },
    driveAgent: async (peer, agentId, action, body) => { driven.push([peer.id, agentId, action, body]); return driveAnswer; },
    onFleet: (agents) => { fleets.push(agents); },
    onOutput: (id, chunk) => { outputs.push([id, chunk]); },
    now: () => clock,
    later: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
    retryMs: 3_000,
    pollTimeoutMs: 1_000,
  };
}
const runTimers = () => { const due = timers.filter(t => t.at <= clock); timers = timers.filter(t => t.at > clock); due.forEach(t => t.fn()); };
const fleetOf = (...ids: string[]) => ({ status: 200, body: { agents: ids.map(id => ({ id, name: `Agent ${id}`, status: 'running', projectPath: 'C:\\code\\tars', cliRunning: true })) } });

beforeEach(() => {
  peers = [PC];
  answers = new Map([[PC.id, fleetOf('a1', 'a2')]]);
  fleets = [];
  outputs = [];
  opened = [];
  clock = Date.parse('2026-10-08T14:00:00.000Z');
  timers = [];
  driven = [];
  driveAnswer = { status: 200, body: { ok: true } };
});

describe('the other machines\' agents', () => {
  it('1. a machine that answers shows its agents under its remote ids and its name', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    expect(fleet.list().map(a => a.id)).toEqual(['m:m-aaaaaaaaaaaaaaaa:a1', 'm:m-aaaaaaaaaaaaaaaa:a2']);
    expect(fleet.list()[0].machine).toEqual({ id: PC.id, name: 'PC', status: 'connected', drive: false });
    expect(fleet.list()[0].projectName).toBe('tars');
  });

  it('2. a machine gone quiet keeps its agents, offline since its first missed poll, and comes back', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    answers.set(PC.id, { status: 0, body: {} });
    clock += 3_000;
    await fleet.poll();
    const since = new Date(clock).toISOString();
    expect(fleet.list().map(a => a.machine)).toEqual([{ id: PC.id, name: 'PC', status: 'offline', offlineSince: since, drive: false }, { id: PC.id, name: 'PC', status: 'offline', offlineSince: since, drive: false }]);
    clock += 3_000;
    await fleet.poll();
    expect(fleet.list()[0].machine.offlineSince).toBe(since);
    answers.set(PC.id, fleetOf('a1'));
    await fleet.poll();
    expect(fleet.list().map(a => [a.agentId, a.machine.status, a.machine.offlineSince])).toEqual([['a1', 'connected', undefined]]);
  });

  it('2. a machine that forgot this one reads unpaired, its agents kept', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    answers.set(PC.id, { status: 401, body: {} });
    await fleet.poll();
    expect(fleet.list().map(a => a.machine.status)).toEqual(['unpaired', 'unpaired']);
  });

  it('3. a machine forgotten here takes its agents with it', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    peers = [];
    await fleet.poll();
    expect(fleet.list()).toEqual([]);
  });

  it('4. the window is told when something moved, and only then', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    await fleet.poll();
    expect(fleets).toHaveLength(1);
    answers.set(PC.id, { status: 0, body: {} });
    await fleet.poll();
    expect(fleets).toHaveLength(2);
    expect(fleets[1][0].machine.status).toBe('offline');
  });

  it('8. a machine that hangs does not hold another\'s poll past its own limit', async () => {
    peers = [PC, NAS];
    answers.set(NAS.id, 'hang');
    const fleet = createRemoteFleet({ ...deps(), pollTimeoutMs: 20 });
    await fleet.poll();
    expect(fleet.list().filter(a => a.machine.status === 'connected').map(a => a.agentId)).toEqual(['a1', 'a2']);
  });
});

describe('live outputs', () => {
  it('5. one stream per remote agent, its chunks under its remote id, closed with the last pane', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ peer: PC.id, agentId: 'a1' });
    opened[0].onChunk('hello\r\n');
    expect(outputs).toEqual([['m:m-aaaaaaaaaaaaaaaa:a1', 'hello\r\n']]);
    fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1');
    expect(opened[0].closed).toBe(false);
    fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1');
    expect(opened[0].closed).toBe(true);
  });

  it('5. a local id, a machine not paired, or an unwatch of nothing opens nothing and never throws', async () => {
    const fleet = createRemoteFleet(deps());
    for (const id of ['a1', 'm:m-cccccccccccccccc:a1', 'm:x:y', '']) {
      expect(() => fleet.watch(id)).not.toThrow();
      expect(() => fleet.unwatch(id)).not.toThrow();
    }
    expect(() => fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1')).not.toThrow();
    expect(opened).toHaveLength(0);
  });

  it('6. a stream that ends while watched opens again, one nobody watches does not', async () => {
    const fleet = createRemoteFleet(deps());
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    opened[0].onEnd();
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1');
    opened[1].onEnd();
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
  });

  it('6. chunks of a stream closed by its last unwatch never reach the window', async () => {
    const fleet = createRemoteFleet(deps());
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1');
    opened[0].onChunk('late');
    expect(outputs).toEqual([]);
  });

  it('9. a retry for an ended stream never opens a second one on a newer watch', async () => {
    const fleet = createRemoteFleet(deps());
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    opened[0].onEnd();
    fleet.unwatch('m:m-aaaaaaaaaaaaaaaa:a1');
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    expect(opened).toHaveLength(2);
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
  });

  it('10. a stream opened again draws the screen first, then what came while it was asked for', async () => {
    let answer: (s: { screen: string; cliRunning: boolean }) => void = () => {};
    const fleet = createRemoteFleet({ ...deps(), fetchScreen: () => new Promise(resolve => { answer = resolve; }) });
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    opened[0].onChunk('first');
    opened[0].onEnd();
    clock += 3_000;
    runTimers();
    expect(opened).toHaveLength(2);
    opened[1].onChunk('after');
    expect(outputs).toEqual([['m:m-aaaaaaaaaaaaaaaa:a1', 'first']]);
    answer({ screen: '\x1bcthe screen', cliRunning: true });
    await new Promise(r => setTimeout(r, 0));
    expect(outputs).toEqual([['m:m-aaaaaaaaaaaaaaaa:a1', 'first'], ['m:m-aaaaaaaaaaaaaaaa:a1', '\x1bcthe screen'], ['m:m-aaaaaaaaaaaaaaaa:a1', 'after']]);
  });

  it('11. a machine forgotten here has its watched streams closed at the next poll', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    fleet.watch('m:m-aaaaaaaaaaaaaaaa:a1');
    peers = [];
    await fleet.poll();
    expect(opened[0].closed).toBe(true);
  });

  it('12. a machine is drivable only while its fleet says it lets this one drive', async () => {
    const fleet = createRemoteFleet(deps());
    await fleet.poll();
    expect(fleet.list()[0].machine.drive).toBe(false);
    answers.set(PC.id, { status: 200, body: { ...fleetOf('a1').body, youMay: 'drive' } });
    await fleet.poll();
    expect(fleet.list()[0].machine.drive).toBe(true);
    answers.set(PC.id, { status: 200, body: { ...fleetOf('a1').body, youMay: 'everything' } });
    await fleet.poll();
    expect(fleet.list()[0].machine.drive).toBe(false);
    answers.set(PC.id, { status: 200, body: { ...fleetOf('a1').body, youMay: 'drive' } });
    await fleet.poll();
    answers.set(PC.id, { status: 0, body: {} });
    await fleet.poll();
    expect(fleet.list()[0].machine.drive).toBe(false);
  });

  it('13. an action goes to the agent\'s own machine, and its sentence comes back as it is', async () => {
    peers = [PC, NAS];
    const fleet = createRemoteFleet(deps());
    expect(await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'stop', { reason: 'night' })).toEqual({ success: true });
    expect(driven).toEqual([[NAS.id, 'x9', 'stop', { reason: 'night' }]]);
    driveAnswer = { status: 403, body: { error: 'NAS lets Mac see only.' } };
    expect(await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'message', { text: 'hi' })).toEqual({ success: false, error: 'NAS lets Mac see only.' });
    driveAnswer = { status: 0, body: {} };
    expect(await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'stop', { reason: 'x' })).toEqual({ success: false, error: 'NAS did not answer.' });
    expect(await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'start', {})).toEqual({ success: false, error: 'NAS did not answer in time. The agent may have started anyway.' });
    driveAnswer = { status: 409, body: { error: 'QA\u202e is\u200b\u0007 busy\n now' } };
    expect(await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'stop', { reason: 'x' })).toEqual({ success: false, error: 'QA is busy now' });
    driveAnswer = { status: 500, body: {} };
    expect((await fleet.drive('m:m-bbbbbbbbbbbbbbbb:x9', 'start', {})).success).toBe(false);
    driven = [];
    for (const id of ['x9', 'm:m-cccccccccccccccc:x9']) expect(await fleet.drive(id, 'start', {})).toEqual({ success: false, error: 'There is no such agent.' });
    expect(driven).toEqual([]);
  });

  it('14. keys go in order, one batch on its way per agent, the keys typed meanwhile gathered behind it', async () => {
    const answers: Array<() => void> = [];
    const sent: string[] = [];
    const fleet = createRemoteFleet({ ...deps(), driveAgent: (_peer, agentId, action, body) => new Promise(resolve => {
      sent.push(`${agentId}:${action}:${String(body.data)}`);
      answers.push(() => resolve({ status: 200, body: { ok: true } }));
    }) });
    const first = fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'h');
    const second = fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'e');
    const third = fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'llo\r');
    expect(sent).toEqual(['a1:keys:h']);
    answers.shift()!();
    await first;
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toEqual(['a1:keys:h', 'a1:keys:ello\r']);
    answers.shift()!();
    expect(await second).toEqual({ success: true });
    expect(await third).toEqual({ success: true });
  });

  it('15. a paste past MAX_KEYS goes in batches of at most MAX_KEYS, in order', async () => {
    const sent: string[] = [];
    const fleet = createRemoteFleet({ ...deps(), driveAgent: async (_peer, _agentId, _action, body) => { sent.push(String(body.data)); return { status: 200, body: { ok: true } }; } });
    const paste = Array.from({ length: MAX_KEYS * 2 + 10 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    expect(await fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', paste)).toEqual({ success: true });
    expect(sent.every(s => s.length <= MAX_KEYS)).toBe(true);
    expect(sent.join('')).toBe(paste);
  });

  it('15. a batch that throws answers its keys and leaves the queue free', async () => {
    let unreadable = true;
    const fleet = createRemoteFleet({ ...deps(), peers: () => { if (unreadable) throw new Error('EBUSY'); return peers; } });
    expect((await fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'x')).success).toBe(false);
    unreadable = false;
    expect(await fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'y')).toEqual({ success: true });
  });

  it('14. a refusal comes back to every key of its batch, and the next keys still go', async () => {
    let status = 403;
    const fleet = createRemoteFleet({ ...deps(), driveAgent: async () => ({ status, body: { error: 'PC lets Mac see only.' } }) });
    expect(await fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'x')).toEqual({ success: false, error: 'PC lets Mac see only.' });
    status = 200;
    expect(await fleet.keys('m:m-aaaaaaaaaaaaaaaa:a1', 'y')).toEqual({ success: true });
    expect(await fleet.keys('a1', 'z')).toEqual({ success: false, error: 'There is no such agent.' });
  });

  it('7. a screen is asked of the agent\'s own machine, and of none for an id that is not remote', async () => {
    peers = [PC, NAS];
    const fleet = createRemoteFleet(deps());
    expect(await fleet.screen('m:m-bbbbbbbbbbbbbbbb:x9')).toEqual({ screen: 'NAS:x9', cliRunning: true });
    expect(await fleet.screen('x9')).toBeNull();
    expect(await fleet.screen('m:m-cccccccccccccccc:x9')).toBeNull();
  });
});
