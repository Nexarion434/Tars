import { describe, it, expect } from 'vitest';
import type { AgentStatus, CloudRemoteAgent, CloudServerView } from '../../src/types/electron';
import {
  ALL_MACHINES, THIS_MACHINE, isRemoteId, folderKey, remoteToAgent, placeRemote, filterByMachine, activeFilter,
  machineFilterOptions, remoteSize, scaleToFit, remoteActions, seeOnlyLine, checkReason, sharesSize, shouldSendSize,
  fleetMatchesSent, fleetMachines, offlineLine, machineStatusLabel, tabMachines, serverStatus,
} from '../../src/lib/cloud';

/**
 * What the Dashboard and the Agents page say about a Tars server's agents
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Tasks 12 and 13). Ported
 * from win/machines' __tests__/lib/machines-remote.test.ts, its failures kept:
 * 1. a project folder compared by more than its name (`\`, a trailing
 *    separator, case), or one that only ends the same way taken for it
 * 2. a server's agent on no local tab when one matches, on one when none does;
 *    a local agent changed, moved or dropped by the merge; the remote path lost
 * 3. a remote id that could meet a local one (a remote id never collides with
 *    a local one), or a status the panel does not know crashing it
 * 4. the filter keeping a server's agents under This Tars, hiding the local
 *    ones under Everywhere, or keeping a server that is gone
 * 5. the filter listing a server this desktop holds no credential for
 * 6. the offline line naming the wrong time or "Invalid Date"; an offline
 *    server's agents losing their last state
 * 7. the status bar saying an offline or disconnected server is connected
 * 8. a remote-only project tab not saying which server it is on
 * 9-10. a remote pane drawn at another size than its terminal's, or scaled
 *    above 1, to 0 or NaN
 * 11. a server's agent started, stopped or typed into while offline, see-only
 *    or disconnected; or not, with drive given and connected
 * 13. a blank reason sent as a stop reason
 * 14-16. a pane sharing its size where it should not, sending a size that did
 *    not change or is no size, or reading the fleet's echo of its own size as a change
 * New in M2:
 * 17. a disconnected server (its credential refused) read as offline, or
 *    told to wait instead of to connect again
 */

const SERVER = { id: 's_1a2b3c4d', serverId: 'd795d0ff4d5d8e50', name: 'srv1539916', status: 'connected' as const, drive: true };
const remote = (over: Partial<CloudRemoteAgent> = {}): CloudRemoteAgent => ({
  id: `c:${SERVER.serverId}:a1`, agentId: 'a1', server: SERVER,
  name: 'QA Engineer', status: 'waiting', projectName: 'tars', projectPath: '/home/tars/code/tars', cliRunning: true, ...over,
});
const local = (id: string, projectPath: string): AgentStatus =>
  ({ id, name: id, status: 'idle', projectPath, skills: [], output: [], lastActivity: '2026-11-03T10:00:00.000Z' }) as AgentStatus;
const view = (over: Partial<CloudServerView> = {}): CloudServerView => ({
  id: 's_1a2b3c4d', host: 'ubuntu@100.101.245.29', runner: { kind: 'docker', container: 'tars-server', sudo: true },
  serverId: SERVER.serverId, name: 'srv1539916', paired: true, state: { phase: 'connected' }, ...over,
});

describe('folders and ids', () => {
  it('a folder is its name, whichever separator wrote it, in lower case (1)', () => {
    expect(folderKey('C:\\Users\\n\\TARS\\')).toBe('tars');
    expect(folderKey('/home/tars/code/tars')).toBe('tars');
    expect(folderKey('/w/tars-old')).not.toBe(folderKey('/w/tars'));
    expect(folderKey('/')).toBe('');
  });

  it('a remote id never collides with a local one (3)', () => {
    expect(isRemoteId(`c:${SERVER.serverId}:a1`)).toBe(true);
    expect(isRemoteId('3f2a9c1e-0000-4000-8000-000000000000')).toBe(false);
    expect(isRemoteId('m:m-bbbb:a1')).toBe(false);
  });
});

describe('a server agent as a pane reads it', () => {
  it('carries what a pane draws, its server and its path (2, 3)', () => {
    const a = remoteToAgent(remote({ provider: 'claude', branch: 'feat/qa', cols: 120, rows: 40 }));
    expect(a).toMatchObject({ id: `c:${SERVER.serverId}:a1`, status: 'waiting', provider: 'claude', branchName: 'feat/qa', skills: [], output: [] });
    expect(a.remote).toEqual({ machineId: 's_1a2b3c4d', machineName: 'srv1539916', status: 'connected', offlineSince: undefined, drive: true, projectPath: '/home/tars/code/tars', cols: 120, rows: 40 });
    expect(remoteToAgent(remote({ status: 'rebooting' })).status).toBe('idle');
  });

  it('files it under the local project of the same folder, keeps every local agent first (2)', () => {
    const l = [local('l1', 'C:\\Users\\n\\Documents\\tars'), local('l2', '/a/x')];
    const out = placeRemote(l, [remote(), remote({ id: `c:${SERVER.serverId}:a2`, projectPath: '/home/tars/code/sakartvelo' })]);
    expect(out.slice(0, 2)).toEqual(l);
    expect(out[2]).toMatchObject({ projectPath: 'C:\\Users\\n\\Documents\\tars', remote: { projectPath: '/home/tars/code/tars' } });
    expect(out[3].projectPath).toBe('/home/tars/code/sakartvelo');
    expect(placeRemote(l, [])).toBe(l);
  });

  it('an offline server keeps its agents last state, and says since when in local time (6)', () => {
    const since = new Date(2026, 10, 3, 9, 5).toISOString();
    const a = remoteToAgent(remote({ status: 'running', server: { ...SERVER, status: 'offline', offlineSince: since, drive: false } }));
    expect(a.status).toBe('running');
    expect(offlineLine(a.remote!)).toBe('srv1539916 offline since 09:05. Its last output stays below, and the pane is live again when srv1539916 is back.');
    expect(offlineLine({ machineName: 'srv1539916', offlineSince: 'garbled' })).not.toMatch(/Invalid/);
  });

  it('a disconnected server says to connect again, not to wait (17)', () => {
    expect(offlineLine({ machineName: 'srv1539916', status: 'disconnected' })).toMatch(/no longer admits this computer.*connect again/);
    expect(machineStatusLabel({ id: 's_1a2b3c4d', name: 'srv1539916', status: 'disconnected' })).toBe('srv1539916 disconnected');
    expect(serverStatus('disconnected')).toBe('disconnected');
    for (const phase of ['off', 'connecting', 'offline', 'failed'] as const) expect(serverStatus(phase), phase).toBe('offline');
  });
});

describe('the filter', () => {
  const all = placeRemote([local('l1', '/a/tars')], [remote(), remote({ id: 'c:aaaaaaaaaaaaaaaa:z', server: { ...SERVER, id: 's_5e6f7a8b', serverId: 'aaaaaaaaaaaaaaaa', name: 'box' } })]);

  it('Everywhere, This Tars, or one server (4)', () => {
    expect(filterByMachine(all, ALL_MACHINES)).toHaveLength(3);
    expect(filterByMachine(all, THIS_MACHINE).map(a => a.id)).toEqual(['l1']);
    expect(filterByMachine(all, 's_5e6f7a8b').map(a => a.id)).toEqual(['c:aaaaaaaaaaaaaaaa:z']);
    expect(activeFilter('s_99999999', [{ id: 's_5e6f7a8b', name: 'box', status: 'connected' }])).toBe(ALL_MACHINES);
    expect(activeFilter('s_5e6f7a8b', [])).toBe(ALL_MACHINES);
  });

  it('lists the servers this desktop holds a credential for, once each, by name (5, 7)', () => {
    const servers = fleetMachines([view(), view({ id: 's_00000000', paired: false, name: undefined })], [remote(), remote()]);
    expect(servers).toEqual([{ id: 's_1a2b3c4d', name: 'srv1539916', status: 'connected' }]);
    expect(fleetMachines([view({ state: { phase: 'offline' } })], [])[0].status).toBe('offline');
    expect(machineFilterOptions(servers).map(o => o.label)).toEqual(['Everywhere', 'This Tars', 'srv1539916']);
    expect(machineStatusLabel({ id: 's_1a2b3c4d', name: 'srv1539916', status: 'offline' })).toBe('srv1539916 offline');
  });

  it('a remote-only project says its server; a tab with a local agent does not (8)', () => {
    const tabs = tabMachines(placeRemote([local('l1', '/a/tars')], [remote(), remote({ id: `c:${SERVER.serverId}:a2`, projectPath: '/srv/writer' })]));
    expect([...tabs]).toEqual([['/srv/writer', ['srv1539916']]]);
  });
});

describe('driving', () => {
  it('only on a connected server that gives drive, start at rest and stop while running (11)', () => {
    expect(remoteActions({ status: 'connected', drive: true }, false)).toEqual({ start: true, stop: false, type: true, seeOnly: false });
    expect(remoteActions({ status: 'connected', drive: true }, true)).toEqual({ start: false, stop: true, type: true, seeOnly: false });
    expect(remoteActions({ status: 'connected', drive: false }, true)).toEqual({ start: false, stop: false, type: false, seeOnly: true });
    for (const status of ['offline', 'disconnected'] as const) {
      expect(remoteActions({ status, drive: true }, true), status).toEqual({ start: false, stop: false, type: false, seeOnly: false });
    }
    expect(remoteActions({ status: 'connected' }, true).type).toBe(false);
    expect(seeOnlyLine('srv1539916')).toMatch(/^srv1539916 lets this Tars see only/);
  });

  it('never a blank stop reason (13)', () => {
    expect(checkReason('  ')).toBeNull();
    expect(checkReason(' done ')).toBe('done');
  });

  it('sizes: the screen first, whole sizes only, a scale at most 1, no echo loop (9, 10, 14, 15, 16)', () => {
    expect(remoteSize({ cols: 100, rows: 30 }, { cols: 120, rows: 40 })).toEqual({ cols: 100, rows: 30 });
    expect(remoteSize({ cols: 100 }, { cols: 0, rows: 40 })).toEqual({ cols: 120, rows: 30 });
    expect(scaleToFit({ width: 2000, height: 2000 }, { width: 800, height: 600 })).toBe(1);
    expect(scaleToFit({ width: 400, height: 600 }, { width: 800, height: 600 })).toBe(0.5);
    expect(scaleToFit({ width: 0, height: 600 }, { width: 800, height: 600 })).toBe(1);
    expect(sharesSize({ status: 'connected', drive: true })).toBe(true);
    expect(sharesSize({ status: 'offline', drive: true })).toBe(false);
    expect(shouldSendSize({ cols: 0, rows: 0 }, { cols: 120, rows: 40 })).toBe(true);
    expect(shouldSendSize({ cols: 120, rows: 40 }, { cols: 120, rows: 40 })).toBe(false);
    expect(shouldSendSize({ cols: 120, rows: 40 }, { cols: 80.5, rows: 40 })).toBe(false);
    expect(fleetMatchesSent({ cols: 120, rows: 40 }, { cols: 120, rows: 40 })).toBe(true);
    expect(fleetMatchesSent({ cols: 120, rows: 40 }, undefined)).toBe(false);
  });
});
