import { describe, it, expect } from 'vitest';
import type { AgentStatus, CloudRemoteAgent, CloudServerView } from '../../src/types/electron';
import {
  ALL_MACHINES, THIS_MACHINE, isRemoteId, folderKey, remoteToAgent, placeRemote, filterByMachine, activeFilter,
  machineFilterOptions, remoteSize, scaleToFit, remoteActions, seeOnlyLine, sharesSize, shouldSendSize,
  fleetMatchesSent, fleetMachines, offlineLine, machineStatusLabel, tabMachines, serverStatus, serverLine, statusWord, serverInput,
  newProjectPlaces, cloudProjectInput, cloudProjectRows, projectPlaceShown, loadCloudProjects, cloudAgentFromForm, sendWhenRunning,
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
 * 13. (gone 2026-11-03: the window asks no stop reason, main sends the
 *    server one that names this computer, cloud-handlers.test.ts)
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
  id: 's_1a2b3c4d', host: 'ubuntu@203.0.113.10', runner: { kind: 'docker', container: 'tars-server', sudo: true },
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

/**
 * Settings > Cloud (Task 11), how its view can fail:
 * 18. a server's line not saying where it is and how it runs, or reading
 *    connected while offline, disconnected or failed; a failed connect
 *    without the sentence main gave (the ssh error in plain words)
 * 19. a server saved with a blank host, a Docker runner without its
 *    container or its door socket, or an installed one without its command;
 *    the command not split into words
 */
describe('Settings > Cloud', () => {
  const at = new Date(2026, 10, 3, 2, 10).toISOString();
  it('says where a server is, how it runs, and its link in words (18)', () => {
    // The frame `Settings · Cloud · connected`: the container and admin rights are in Advanced, not on the line.
    expect(serverLine(view({ state: { phase: 'connected', since: at } }))).toBe('ubuntu@203.0.113.10 · Docker · connected since 02:10');
    expect(serverLine(view({ runner: { kind: 'command', argv: ['node', '/srv/tars/electron/dist/server/cli.js'] }, state: { phase: 'offline', since: at } })))
      .toBe('ubuntu@203.0.113.10 · installed · offline since 02:10, trying again by itself');
    expect(serverLine(view({ state: { phase: 'disconnected', sentence: 'It refused this computer.' } }))).toBe('ubuntu@203.0.113.10 · Docker · disconnected by the server. It refused this computer.');
    expect(serverLine(view({ state: { phase: 'failed', problem: 'host-key-unknown', sentence: 'Run ssh once in a terminal.' } }))).toBe('ubuntu@203.0.113.10 · Docker · Run ssh once in a terminal.');
    expect(serverLine(view({ state: { phase: 'off' } }))).toBe('ubuntu@203.0.113.10 · Docker · not connected');
    expect(statusWord('connected')).toEqual({ word: 'connected', tone: 'running' });
    for (const phase of ['offline', 'off', 'connecting'] as const) expect(statusWord(phase).tone, phase).toBe('idle');
    for (const phase of ['disconnected', 'failed'] as const) expect(statusWord(phase).tone, phase).toBe('error');
  });

  it('a server form is whole before it is sent (19)', () => {
    const docker = { host: ' ubuntu@203.0.113.10 ', runs: 'docker' as const, container: 'tars-server', sudo: true, doorSocket: '/home/ubuntu/tars-cloud/home/.tars-private/door.sock', command: '' };
    expect(serverInput(docker)).toEqual({ ok: true, input: { host: 'ubuntu@203.0.113.10', runner: { kind: 'docker', container: 'tars-server', sudo: true }, doorSocket: docker.doorSocket } });
    // Each error names the field as Settings > Cloud labels it.
    expect(serverInput({ ...docker, host: '  ' })).toMatchObject({ ok: false, error: expect.stringMatching(/server address/) });
    expect(serverInput({ ...docker, container: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/container name/) });
    // M3 Task 6: on Docker the door path is found for you when the server says it; left empty, it is not sent.
    expect(serverInput({ ...docker, doorSocket: '  ' })).toEqual({ ok: true, input: { host: 'ubuntu@203.0.113.10', runner: { kind: 'docker', container: 'tars-server', sudo: true } } });
    const installed = { ...docker, runs: 'command' as const, command: '  node   /srv/tars/electron/dist/server/cli.js ' };
    expect(serverInput(installed)).toEqual({ ok: true, input: { host: 'ubuntu@203.0.113.10', runner: { kind: 'command', argv: ['node', '/srv/tars/electron/dist/server/cli.js'] } } });
    expect(serverInput({ ...installed, command: ' ' })).toMatchObject({ ok: false, error: expect.stringMatching(/command/) });
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

/**
 * M3 Task 8, New project from this computer (frames `Overlay · New project · where`, `· from Git`, `· name taken`).
 * How it fails, written before the code:
 * 20. a server offered as a place that is not connected, or offered without
 *     the line the frame gives it (connected · <host>); This computer not
 *     first, or missing
 * 21. a form sent with no name, or a Git start with no address, instead of
 *     a sentence; a name or an address sent with spaces around it; fields
 *     the door does not take sent along (the server checks the name and the
 *     address again: it is the one authority)
 */
describe('New project, where it lives (M3)', () => {
  it('offers this computer first, then the connected servers only (20)', () => {
    const servers = [
      view({ id: 's_1a2b3c4d', name: 'my-server', host: 'user@server', state: { phase: 'connected' } }),
      view({ id: 's_2b3c4d5e', name: 'old', host: 'user@old', state: { phase: 'offline' } }),
      view({ id: 's_3c4d5e6f', name: undefined, host: 'user@third', state: { phase: 'connected' } }),
    ];
    expect(newProjectPlaces(servers)).toEqual([
      { id: 'local', label: 'This computer', line: 'a folder you pick' },
      { id: 's_1a2b3c4d', label: 'my-server', line: 'connected · user@server' },
      { id: 's_3c4d5e6f', label: 'user@third', line: 'connected · user@third' },
    ]);
    expect(newProjectPlaces([])).toEqual([{ id: 'local', label: 'This computer', line: 'a folder you pick' }]);
  });

  it('turns the form into what the door takes, or says what is missing (21)', () => {
    expect(cloudProjectInput({ name: '  my-app ', start: 'empty', url: 'ignored' })).toEqual({ ok: true, body: { name: 'my-app', from: { kind: 'empty' } } });
    expect(cloudProjectInput({ name: 'my-app', start: 'git', url: ' git@github.com:a/b.git ' })).toEqual({ ok: true, body: { name: 'my-app', from: { kind: 'git', url: 'git@github.com:a/b.git' } } });
    expect(cloudProjectInput({ name: ' ', start: 'empty', url: '' })).toEqual({ ok: false, error: 'Give the project a name.' });
    expect(cloudProjectInput({ name: 'my-app', start: 'git', url: '  ' })).toEqual({ ok: false, error: "Give the repository's address." });
  });
});

/**
 * M3, the Projects page with a server's projects (frame `Projects · with cloud`).
 * How it fails, written before the code:
 * 22. a server's project without its server (badge), with a key a local
 *     path could take, or its path shown as the server's home instead of ~
 * 23. its agents counted from another server's, or from another folder
 * 24. the location filter: Everywhere hiding either side, This Tars showing
 *     a server's project, a server showing this computer's or another
 *     server's
 */
describe('Projects with a server\'s projects (M3)', () => {
  const server = { id: 's_1a2b3c4d', serverId: SERVER.serverId, name: 'my-server' };
  const other = { id: 's_9f8e7d6c', serverId: 'aaaaaaaaaaaaaaaa', name: 'other' };
  const sets = [
    { server, projects: [{ name: 'my-app', path: '/home/tars/projects/my-app' }, { name: 'api', path: '/root/projects/api' }] },
    { server: other, projects: [{ name: 'my-app', path: '/home/tars/projects/my-app' }] },
  ];

  it('rows: the server named, a key of its own, ~ for its home (22), its agents counted (23)', () => {
    const agents = [
      remote({ projectPath: '/home/tars/projects/my-app' }),
      remote({ id: `c:${SERVER.serverId}:a2`, agentId: 'a2', projectPath: '/home/tars/projects/my-app/' }),
      remote({ id: 'c:aaaaaaaaaaaaaaaa:a3', agentId: 'a3', projectPath: '/home/tars/projects/my-app', server: { ...SERVER, id: other.id, serverId: other.serverId, name: 'other' } }),
      remote({ id: `c:${SERVER.serverId}:a4`, agentId: 'a4', projectPath: '/home/tars/projects/elsewhere' }),
    ];
    expect(cloudProjectRows(sets, agents)).toEqual([
      { key: `cloud:${SERVER.serverId}:/home/tars/projects/my-app`, name: 'my-app', path: '/home/tars/projects/my-app', shownPath: '~/projects/my-app', server: { id: server.id, name: 'my-server' }, agents: 2 },
      { key: `cloud:${SERVER.serverId}:/root/projects/api`, name: 'api', path: '/root/projects/api', shownPath: '~/projects/api', server: { id: server.id, name: 'my-server' }, agents: 0 },
      { key: 'cloud:aaaaaaaaaaaaaaaa:/home/tars/projects/my-app', name: 'my-app', path: '/home/tars/projects/my-app', shownPath: '~/projects/my-app', server: { id: other.id, name: 'other' }, agents: 1 },
    ]);
  });

  it('the location filter (24)', () => {
    const rows = cloudProjectRows(sets, []);
    expect(projectPlaceShown(ALL_MACHINES, null)).toBe(true);
    expect(projectPlaceShown(ALL_MACHINES, rows[0])).toBe(true);
    expect(projectPlaceShown(THIS_MACHINE, null)).toBe(true);
    expect(projectPlaceShown(THIS_MACHINE, rows[0])).toBe(false);
    expect(projectPlaceShown(server.id, rows[0])).toBe(true);
    expect(projectPlaceShown(server.id, rows[2])).toBe(false);
    expect(projectPlaceShown(server.id, null)).toBe(false);
  });
});

/**
 * M3, the Projects page loading a server's projects. Written before the code.
 * How it fails:
 * 25. a server asked that is not connected, or that this computer holds no
 *     server id for; one server's failure taking the others with it; a
 *     server shown under another name than its badge's
 */
describe('loading a server\'s projects (M3)', () => {
  it('asks each connected server once, and keeps the others when one fails (25)', async () => {
    const asked: string[] = [];
    const api = {
      list: async () => [
        view({ id: 's_1a2b3c4d', name: 'my-server', state: { phase: 'connected' } }),
        view({ id: 's_2b3c4d5e', name: 'down', state: { phase: 'offline' } }),
        view({ id: 's_3c4d5e6f', name: undefined, host: 'user@third', serverId: 'bbbbbbbbbbbbbbbb', state: { phase: 'connected' } }),
        view({ id: 's_4d5e6f70', name: 'unpaired', serverId: undefined, state: { phase: 'connected' } }),
      ],
      projects: async (id: string) => {
        asked.push(id);
        return id === 's_3c4d5e6f' ? { success: false as const, error: 'The server did not answer: the link dropped.' } : { success: true as const, projects: [{ name: 'my-app', path: '/home/tars/projects/my-app' }] };
      },
    };
    expect(await loadCloudProjects(api)).toEqual([
      { server: { id: 's_1a2b3c4d', serverId: SERVER.serverId, name: 'my-server' }, projects: [{ name: 'my-app', path: '/home/tars/projects/my-app' }] },
    ]);
    expect(asked).toEqual(['s_1a2b3c4d', 's_3c4d5e6f']);
  });
});

/**
 * M3 Task 9, New agent in a server's project (frame `Overlay · New agent · cloud project`). Written before the code.
 * How it fails:
 * 26. the form sent to the server with what a server's agent cannot have
 *     (its own worktree, a CLI path of this computer's, the orchestrator
 *     role) instead of a sentence; the project sent by anything but its
 *     path on the server; the agent not started ("Create and start"); the
 *     task sent as a field the door does not take instead of kept for after
 *     the start
 */
describe('New agent in a server\'s project (M3 Task 9)', () => {
  const project = cloudProjectRows([{ server: { id: 's_1a2b3c4d', serverId: SERVER.serverId, name: 'my-server' }, projects: [{ name: 'my-app', path: '/home/tars/projects/my-app' }] }], [])[0];

  it('the form as the door takes it, started, the task kept for after (26)', () => {
    expect(cloudAgentFromForm(project, { skills: ['tdd'], prompt: '  Fix the chart.  ', model: 'haiku', name: 'Frontend Engineer', provider: 'claude', effort: 'medium', permissionMode: 'auto', character: 'robot', role: 'worker' }))
      .toEqual({
        ok: true, serverId: 's_1a2b3c4d', task: 'Fix the chart.',
        body: { projectPath: '/home/tars/projects/my-app', name: 'Frontend Engineer', provider: 'claude', model: 'haiku', effort: 'medium', permissionMode: 'auto', skills: ['tdd'], character: 'robot', start: true },
      });
    expect(cloudAgentFromForm(project, { skills: [], prompt: ' ' })).toMatchObject({ ok: true, task: null, body: { projectPath: '/home/tars/projects/my-app', skills: [], start: true } });
  });

  it('says what a server\'s agent cannot have (26)', () => {
    expect(cloudAgentFromForm(project, { skills: [], prompt: '', worktree: { enabled: true, branchName: 'feat/x' } })).toMatchObject({ ok: false, error: expect.stringMatching(/worktree/) });
    expect(cloudAgentFromForm(project, { skills: [], prompt: '', cliPath: '/usr/local/bin/claude' })).toMatchObject({ ok: false, error: expect.stringMatching(/CLI/) });
    expect(cloudAgentFromForm(project, { skills: [], prompt: '', role: 'orchestrator' })).toMatchObject({ ok: false, error: expect.stringMatching(/orchestrator/) });
    expect(cloudAgentFromForm(project, { skills: [], prompt: '', worktree: { enabled: false, branchName: '' } })).toMatchObject({ ok: true });
  });
});

/**
 * M3 Task 9, the task of a server's new agent, sent once its CLI runs. Written before the code.
 * How it fails:
 * 27. the task typed before the CLI runs (into a bare shell), sent twice,
 *     sent to another agent, or the wait without end; a refused message not
 *     said
 */
describe('the task of a server\'s new agent (M3 Task 9)', () => {
  const id = `c:${SERVER.serverId}:a-new`;
  it('waits for the CLI, then sends the task once, to that agent (27)', async () => {
    const seen = [[remote({ id, agentId: 'a-new', cliRunning: false })], [remote({ id: `c:${SERVER.serverId}:other`, cliRunning: true }), remote({ id, agentId: 'a-new', cliRunning: false })], [remote({ id, agentId: 'a-new', cliRunning: true })]];
    const sent: Array<[string, string, number]> = [];
    let reads = 0;
    const answer = await sendWhenRunning(id, 'Fix the chart.', {
      agents: async () => { reads += 1; return seen.shift() ?? []; },
      message: async (remoteId, text) => { sent.push([remoteId, text, reads]); return { success: true }; },
      wait: async () => {},
    }, { tries: 10 });
    expect(answer).toEqual({ sent: true });
    // Sent at the third reading, the first where its CLI runs: never while only its shell is there.
    expect(sent).toEqual([[id, 'Fix the chart.', 3]]);
  });

  it('gives up after its tries, and says a refused message (27)', async () => {
    const never = await sendWhenRunning(id, 'x', { agents: async () => [], message: async () => ({ success: true }), wait: async () => {} }, { tries: 3 });
    expect(never).toEqual({ sent: false, error: 'The agent started, but its CLI did not come up: the task was not sent. Type it in its terminal.' });
    const refused = await sendWhenRunning(id, 'x', {
      agents: async () => [remote({ id, agentId: 'a-new', cliRunning: true })],
      message: async () => ({ success: false, error: 'This agent has no terminal running.' }),
      wait: async () => {},
    }, { tries: 3 });
    expect(refused).toEqual({ sent: false, error: 'This agent has no terminal running.' });
  });
});
