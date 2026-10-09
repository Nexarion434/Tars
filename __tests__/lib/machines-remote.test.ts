import { describe, it, expect } from 'vitest';
import type { AgentStatus, RemoteAgent } from '../../src/types/electron';
import {
  ALL_MACHINES, THIS_MACHINE, isRemoteId, folderKey, remoteToAgent, placeRemote, filterByMachine, activeFilter,
  localMachineLabel, machineFilterOptions, remoteSize, scaleToFit, remoteActions, seeOnlyLine, checkReason, sharesSize, shouldSendSize, fleetMatchesSent, fleetMachines, offlineLine, readOnlyTitle, machineStatusLabel, tabMachines,
} from '../../src/lib/machines';

/**
 * What the Dashboard and the Agents page say about the agents of another
 * machine. How it can fail, written before the code:
 * 1. A project folder is compared by more than its name: a Windows path with
 *    `\`, a trailing separator, a `~\` home, or a different case makes the
 *    same folder two projects; or a folder that only ends the same way
 *    (`tars-old` against `tars`) is taken for it.
 * 2. A remote agent lands on no local tab when one matches, or on a local tab
 *    when none does; two remote machines with the same folder get two tabs;
 *    a local agent is changed, moved or dropped by the merge; the remote's
 *    own path is lost (the Agents page shows it as given).
 * 3. A remote agent keeps an id that could meet a local one, or carries a
 *    status the panel does not know (it must read as idle, not crash).
 * 4. The machine filter keeps the other machine's agents under This Mac, hides
 *    the local ones under All machines, or keeps a machine that is gone and
 *    leaves the board empty with no way back.
 * 5. The local machine is called by the wrong name on a platform; the filter
 *    lists a machine twice, or one that forgot this machine.
 * 6. The offline line names the wrong time (UTC instead of local, no zero
 *    padding), prints "Invalid Date" when offlineSince is missing or garbled,
 *    or promises a return of the wrong machine.
 * 7. The status bar says an offline or unknown machine is connected.
 * 8. A remote-only project tab does not say which machine it is on, or a tab
 *    with a local agent in it claims to be remote.
 * 9. A remote pane is drawn at another size than its terminal's: the size the
 *    screen came with is ignored for the agent's, or the agent's for the
 *    default; half a size (cols without rows, 0, NaN, a fraction) is used;
 *    the fallback order is wrong.
 * 10. The scale to fit goes above 1 (a small terminal blown up), is 0 or NaN
 *    for a body not laid out yet or a terminal with no size, or follows only
 *    one of the two sides so the other overflows.
 * 11. A remote agent can be started, stopped or messaged while its machine
 *    is offline or lets this one only see; or cannot be, with Drive given and
 *    the machine connected; keys are typed into the pane of a machine that is
 *    offline or lets this one only see, or refused with Drive given; start is offered on a running agent, or stop on
 *    one at rest; a machine with no `drive` reads as allowing it.
 * 12. The see-only sentence names the wrong machine or the wrong local
 *    machine (Mac, PC, machine), or shows on an offline machine.
 * 13. A blank reason is sent as a stop reason.
 * 14. A pane takes the size of the terminal it looks at where it should not
 *    (offline, or a machine that lets this one see only), or does not where
 *    it should (connected, Drive given).
 * 15. A pane sends its size when it did not change (a resize per layout
 *    tick), does not send it when it did, sends a size that is no size (0,
 *    NaN, a fraction), or sends nothing the first time (nothing sent yet).
 * 16. The fleet's size is read as a change when it is what the pane just
 *    sent (a reset loop: send, the fleet echoes it, the screen is read and
 *    the pane resized, which sends again), or as a match when the other
 *    machine took the size back; a fleet with no size is read as a change.
 */

const remote = (over: Partial<RemoteAgent> = {}): RemoteAgent => ({
  id: 'm:m-bbbb:a1', agentId: 'a1', machine: { id: 'm-bbbb', name: 'PC', status: 'connected' },
  name: 'QA Engineer', status: 'waiting', projectName: 'tars', projectPath: 'C:\\Users\\n\\tars', cliRunning: true, ...over,
});
const local = (id: string, projectPath: string): AgentStatus =>
  ({ id, name: id, status: 'idle', projectPath, skills: [], output: [], lastActivity: '2026-10-08T10:00:00.000Z' }) as AgentStatus;

describe('folderKey', () => {
  it('is the folder name, whichever separator wrote it, in lower case (1)', () => {
    expect(folderKey('/Users/n/Tars')).toBe('tars');
    expect(folderKey('C:\\Users\\n\\tars')).toBe('tars');
    expect(folderKey('C:/Users/n/TARS/')).toBe('tars');
    expect(folderKey('~\\sakartvelo')).toBe('sakartvelo');
    expect(folderKey('/Users/n/tars\\')).toBe('tars');
  });
  it('does not take a name that only ends the same way for the folder (1)', () => {
    expect(folderKey('/w/tars-old')).not.toBe(folderKey('/w/tars'));
    expect(folderKey('/w/old-tars')).not.toBe(folderKey('/w/tars'));
  });
  it('is empty for no path, so nothing matches it by accident (1)', () => {
    expect(folderKey('')).toBe('');
    expect(folderKey('/')).toBe('');
  });
});

describe('isRemoteId', () => {
  it('tells a remote id from a local one (3)', () => {
    expect(isRemoteId('m:m-bbbb:a1')).toBe(true);
    expect(isRemoteId('3f2a9c1e-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('remoteToAgent', () => {
  it('carries what a pane draws, and its machine and path as given (2, 3)', () => {
    const a = remoteToAgent(remote({ provider: 'gemini', model: 'gemini-3-pro', branch: 'feat/qa', currentTask: 'run tests' }));
    expect(a).toMatchObject({
      id: 'm:m-bbbb:a1', name: 'QA Engineer', status: 'waiting', provider: 'gemini', model: 'gemini-3-pro',
      branchName: 'feat/qa', currentTask: 'run tests', cliRunning: true, projectPath: 'C:\\Users\\n\\tars', skills: [], output: [],
    });
    expect(a.remote).toEqual({ machineId: 'm-bbbb', machineName: 'PC', status: 'connected', offlineSince: undefined, projectPath: 'C:\\Users\\n\\tars' });
  });
  it('reads a status the panel does not know as idle (3)', () => {
    expect(remoteToAgent(remote({ status: 'rebooting' })).status).toBe('idle');
    for (const s of ['idle', 'running', 'completed', 'error', 'waiting', 'stopped', 'asleep']) expect(remoteToAgent(remote({ status: s })).status).toBe(s);
  });
  it('keeps the offline time of its machine (6)', () => {
    const a = remoteToAgent(remote({ machine: { id: 'm-bbbb', name: 'PC', status: 'offline', offlineSince: '2026-10-08T12:02:00Z' } }));
    expect(a.remote).toMatchObject({ status: 'offline', offlineSince: '2026-10-08T12:02:00Z' });
  });
});

describe('placeRemote', () => {
  it('puts a remote agent under the local project with the same folder name (2)', () => {
    const l = [local('l1', '/Users/n/Documents/tars')];
    const [, r] = placeRemote(l, [remote()]);
    expect(r?.projectPath).toBe('/Users/n/Documents/tars');
    expect(r?.remote?.projectPath).toBe('C:\\Users\\n\\tars');
  });
  it('leaves a remote agent with no local match on its own project (2)', () => {
    const [, r] = placeRemote([local('l1', '/Users/n/other')], [remote({ projectPath: 'C:\\x\\sakartvelo' })]);
    expect(r?.projectPath).toBe('C:\\x\\sakartvelo');
  });
  it('does not match a folder that only ends the same way (1, 2)', () => {
    const [, r] = placeRemote([local('l1', '/w/tars-old')], [remote()]);
    expect(r?.projectPath).toBe('C:\\Users\\n\\tars');
  });
  it('gives two machines with the same folder one project (2)', () => {
    const out = placeRemote([], [
      remote({ id: 'm:m-1:a', projectPath: 'C:\\a\\Writer' }),
      remote({ id: 'm:m-2:b', machine: { id: 'm-2', name: 'Mini', status: 'connected' }, projectPath: '/Users/z/writer' }),
    ]);
    expect(out[0]?.projectPath).toBe(out[1]?.projectPath);
  });
  it('keeps every local agent, first, as it was (2)', () => {
    const l = [local('l1', '/a/tars'), local('l2', '/a/x')];
    const out = placeRemote(l, [remote()]);
    expect(out.slice(0, 2)).toEqual(l);
    expect(out[0]).toBe(l[0]);
    expect(out).toHaveLength(3);
  });
  it('is the local list itself when there is nothing remote (2)', () => {
    const l = [local('l1', '/a/tars')];
    expect(placeRemote(l, [])).toEqual(l);
  });
});

describe('filterByMachine', () => {
  const l = local('l1', '/a/tars');
  const all = placeRemote([l], [remote(), remote({ id: 'm:m-2:z', machine: { id: 'm-2', name: 'Mini', status: 'connected' } })]);
  it('keeps everything under All machines (4)', () => {
    expect(filterByMachine(all, ALL_MACHINES)).toHaveLength(3);
  });
  it('keeps only this machine under This Mac (4)', () => {
    expect(filterByMachine(all, THIS_MACHINE).map(a => a.id)).toEqual(['l1']);
  });
  it('keeps only one machine under its id (4)', () => {
    expect(filterByMachine(all, 'm-2').map(a => a.id)).toEqual(['m:m-2:z']);
  });
  it('is back to all when the machine is gone (4)', () => {
    expect(activeFilter('m-9', [{ id: 'm-2', name: 'Mini', status: 'connected' }])).toBe(ALL_MACHINES);
    expect(activeFilter('m-2', [{ id: 'm-2', name: 'Mini', status: 'connected' }])).toBe('m-2');
    expect(activeFilter(THIS_MACHINE, [{ id: 'm-2', name: 'Mini', status: 'connected' }])).toBe(THIS_MACHINE);
    expect(activeFilter(THIS_MACHINE, [])).toBe(ALL_MACHINES);
  });
});

describe('the filter and its words', () => {
  it('names this machine by its platform (5)', () => {
    expect(localMachineLabel('darwin')).toBe('This Mac');
    expect(localMachineLabel('win32')).toBe('This PC');
    expect(localMachineLabel('linux')).toBe('This machine');
    expect(localMachineLabel('')).toBe('This machine');
  });
  it('lists All machines, this one, then each other by name (5)', () => {
    expect(machineFilterOptions([{ id: 'm-b', name: 'PC', status: 'connected' }], 'darwin')).toEqual([
      { value: 'all', label: 'All machines' }, { value: 'local', label: 'This Mac' }, { value: 'm-b', label: 'PC' },
    ]);
  });
  it('knows a machine from the peers, once, and from its agents when the peers lack it (5)', () => {
    const peers = [
      { id: 'm-b', name: 'PC', status: 'connected' as const },
      { id: 'm-c', name: 'Old', status: 'unpaired' as const },
    ];
    const agents = [remote({ machine: { id: 'm-b', name: 'PC', status: 'connected' } }), remote({ id: 'm:m-d:q', machine: { id: 'm-d', name: 'Mini', status: 'offline' } })];
    expect(fleetMachines(peers, agents).map(m => m.id)).toEqual(['m-b', 'm-d']);
  });
});

describe('offlineLine', () => {
  it('says the machine, the local time, and that the pane comes back with it (6)', () => {
    const iso = new Date(2026, 9, 8, 14, 2).toISOString();
    expect(offlineLine({ machineName: 'PC', offlineSince: iso })).toBe('PC offline since 14:02. Its last output stays below, and the pane is live again when the PC is back.');
  });
  it('pads the hour and the minutes (6)', () => {
    const iso = new Date(2026, 9, 8, 9, 5).toISOString();
    expect(offlineLine({ machineName: 'Mini', offlineSince: iso })).toContain('Mini offline since 09:05.');
  });
  it('says no time when there is none, or it is not a date (6)', () => {
    const tail = 'Its last output stays below, and the pane is live again when the PC is back.';
    expect(offlineLine({ machineName: 'PC' })).toBe(`PC offline. ${tail}`);
    expect(offlineLine({ machineName: 'PC', offlineSince: 'not a date' })).toBe(`PC offline. ${tail}`);
  });
});

describe('readOnlyTitle and machineStatusLabel', () => {
  it('says where the agent runs (title)', () => {
    expect(readOnlyTitle('PC')).toBe('Read only: this agent runs on PC');
  });
  it('ticks a connected machine and says offline for any other (7)', () => {
    expect(machineStatusLabel({ id: 'm-b', name: 'PC', status: 'connected' })).toBe('PC ✓');
    expect(machineStatusLabel({ id: 'm-b', name: 'PC', status: 'offline' })).toBe('PC offline');
    expect(machineStatusLabel({ id: 'm-b', name: 'PC', status: 'unknown' })).toBe('PC offline');
  });
});

describe('tabMachines', () => {
  it('names the machines of a project only remote agents are on (8)', () => {
    const agents = placeRemote([local('l1', '/a/tars')], [
      remote(), remote({ id: 'm:m-bbbb:w', projectPath: 'C:\\x\\sakartvelo' }),
      remote({ id: 'm:m-2:w', machine: { id: 'm-2', name: 'Mini', status: 'connected' }, projectPath: 'C:\\x\\sakartvelo' }),
    ]);
    const tabs = tabMachines(agents);
    expect(tabs.has('/a/tars')).toBe(false);
    expect(tabs.get('C:\\x\\sakartvelo')).toEqual(['PC', 'Mini']);
  });
});

describe('remoteSize', () => {
  it('takes the size of the screen first, then the agent, then 120x30 (9)', () => {
    expect(remoteSize({ cols: 100, rows: 40 }, { cols: 80, rows: 24 })).toEqual({ cols: 100, rows: 40 });
    expect(remoteSize(null, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(remoteSize({}, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(remoteSize(null, undefined)).toEqual({ cols: 120, rows: 30 });
  });
  it('never uses half a size or one that is no size (9)', () => {
    expect(remoteSize({ cols: 100 }, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(remoteSize({ cols: 0, rows: 0 }, undefined)).toEqual({ cols: 120, rows: 30 });
    expect(remoteSize({ cols: Number.NaN, rows: 30 }, undefined)).toEqual({ cols: 120, rows: 30 });
    expect(remoteSize({ cols: 80.5, rows: 24 }, undefined)).toEqual({ cols: 120, rows: 30 });
  });
});

describe('scaleToFit', () => {
  it('shrinks to the tighter side (10)', () => {
    expect(scaleToFit({ width: 500, height: 600 }, { width: 1000, height: 400 })).toBe(0.5);
    expect(scaleToFit({ width: 900, height: 200 }, { width: 600, height: 400 })).toBe(0.5);
  });
  it('never grows a terminal that fits (10)', () => {
    expect(scaleToFit({ width: 2000, height: 2000 }, { width: 600, height: 400 })).toBe(1);
  });
  it('is 1, never 0 or NaN, when a size is not known yet (10)', () => {
    expect(scaleToFit({ width: 0, height: 0 }, { width: 600, height: 400 })).toBe(1);
    expect(scaleToFit({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1);
    expect(scaleToFit({ width: Number.NaN, height: 500 }, { width: 600, height: 400 })).toBe(1);
  });
});

describe('remoteActions', () => {
  const info = (over: object = {}) => ({ machineId: 'm', machineName: 'PC', status: 'connected' as const, drive: true, projectPath: '/x', ...over });
  it('offers stop to a running agent and start to one at rest, where Drive is given (11)', () => {
    expect(remoteActions(info(), true)).toMatchObject({ start: false, stop: true, type: true, seeOnly: false });
    expect(remoteActions(info(), false)).toMatchObject({ start: true, stop: false, type: true, seeOnly: false });
  });
  it('offers nothing to a machine that only lets this one see, and says so (11, 12)', () => {
    expect(remoteActions(info({ drive: false }), true)).toEqual({ start: false, stop: false, type: false, seeOnly: true });
    expect(remoteActions(info({ drive: undefined }), false)).toEqual({ start: false, stop: false, type: false, seeOnly: true });
  });
  it('offers nothing while the machine is offline, whatever Drive says, and no see-only line (11, 12)', () => {
    for (const status of ['offline', 'unknown', 'unpaired'] as const) {
      expect(remoteActions(info({ status }), true)).toEqual({ start: false, stop: false, type: false, seeOnly: false });
    }
  });
});

describe('seeOnlyLine', () => {
  it('names the machine and this one by its platform (12)', () => {
    expect(seeOnlyLine('PC', 'darwin')).toBe('PC lets this Mac see only. To start, stop or type into its agents, choose Drive for this Mac on PC, in Settings > Machines.');
    expect(seeOnlyLine('Mini', 'win32')).toBe('Mini lets this PC see only. To start, stop or type into its agents, choose Drive for this PC on Mini, in Settings > Machines.');
    expect(seeOnlyLine('Mini', 'linux')).toContain('lets this machine see only.');
  });
});

describe('checkReason', () => {
  it('wants a stop reason that is not blank (13)', () => {
    expect(checkReason(' done for today ')).toBe('done for today');
    expect(checkReason('  ')).toBeNull();
  });
});

describe('sharesSize', () => {
  it('is true only for a connected machine that lets this one drive (14)', () => {
    expect(sharesSize({ status: 'connected', drive: true })).toBe(true);
    expect(sharesSize({ status: 'connected', drive: false })).toBe(false);
    expect(sharesSize({ status: 'connected' })).toBe(false);
    expect(sharesSize({ status: 'offline', drive: true })).toBe(false);
    expect(sharesSize({ status: 'unknown', drive: true })).toBe(false);
  });
});

describe('shouldSendSize', () => {
  it('sends a size that changed, and the first one (15)', () => {
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: 100, rows: 24 })).toBe(true);
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: 80, rows: 30 })).toBe(true);
    expect(shouldSendSize({ cols: 0, rows: 0 }, { cols: 80, rows: 24 })).toBe(true);
  });
  it('does not send the size it sent last (15)', () => {
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
  });
  it('never sends a size that is no size (15)', () => {
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: 0, rows: 24 })).toBe(false);
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: Number.NaN, rows: 24 })).toBe(false);
    expect(shouldSendSize({ cols: 80, rows: 24 }, { cols: 80.5, rows: 24 })).toBe(false);
  });
});

describe('fleetMatchesSent', () => {
  it('matches the size the pane sent, which is no change to read again (16)', () => {
    expect(fleetMatchesSent({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
  });
  it('does not match when the other machine took the size back (16)', () => {
    expect(fleetMatchesSent({ cols: 80, rows: 24 }, { cols: 180, rows: 45 })).toBe(false);
    expect(fleetMatchesSent({ cols: 0, rows: 0 }, { cols: 180, rows: 45 })).toBe(false);
  });
  it('does not match a fleet that says no size (16)', () => {
    expect(fleetMatchesSent({ cols: 80, rows: 24 }, {})).toBe(false);
    expect(fleetMatchesSent({ cols: 80, rows: 24 }, undefined)).toBe(false);
  });
});
