import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listClients } from '../../../electron/services/cloud/clients';
import { startDoor, type Door, type DoorCreate } from '../../../electron/services/cloud/door';
import { doorSocketPath } from '../../../electron/services/cloud/door-socket';
import { runCreateCommand } from '../../../electron/server/create-command';

/**
 * tars-server projects add | agents add (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 5): what the real test of 2026-11-03 had to do by hand (Test cloud
 * written into agents.json, the server stopped).
 *
 * How it fails, written before the code:
 * 1. the input taken from the command line (a remote shell would read it)
 *    instead of stdin, or not a JSON object
 * 2. the server not running, and the CLI writing agents.json itself (the
 *    running server would overwrite it) instead of refusing
 * 3. another path than the door's create routes: other checks, or the
 *    running server's fleet not holding the agent
 * 4. the operator's client left behind after the call, even when it fails
 * 5. a refusal (a taken name) exiting 0, or without its sentence
 * 6. an unknown verb exiting 0
 * 7. (security review 1, B1) a clone made without the operator's explicit
 *    --trust-code, a `trusted` in the input taken for it, or the flag
 *    asked of an empty project
 */

const doors: Door[] = [];
afterEach(async () => { for (const d of doors.splice(0)) await d.close(); });

async function setup() {
  const clientsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-create-cmd-')), 'cloud-clients.json');
  const made: unknown[][] = [];
  const create: DoorCreate = {
    projects: () => [{ name: 'test-cloud', path: '/home/tars/projects/test-cloud' }],
    project: async (name, from) => { made.push(['project', name, from]); return name === 'taken' ? { ok: false, status: 409, error: 'A project named "taken" is already on this server.' } : { ok: true, path: `/home/tars/projects/${name}` }; },
    agent: async fields => { made.push(['agent', fields]); return { ok: true, agent: { id: 'a-new', name: String(fields.name) } }; },
    gitKey: async () => ({ ok: false, error: 'not here' }),
  };
  const door = await startDoor({
    socketPath: doorSocketPath(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-door-'))),
    clientsFile,
    identity: () => ({ id: '0123456789abcdef', name: 'vps', version: '9.9.9' }),
    fleet: () => ({}),
    drive: async () => ({ ok: true as const }),
    create,
  });
  doors.push(door);
  const lines: string[] = [];
  const deps = { clientsFile, socketPath: door.path, serverRunning: () => true };
  return { deps, made, lines, out: (l: string) => lines.push(l), clientsFile };
}

describe('tars-server projects add, a clone (7)', () => {
  const clone = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'repo', from: { kind: 'git', url: 'https://github.com/a/b', ...extra } });
  it('7. no --trust-code, no clone: exit 1 with the flag named, even with trusted in the input', async () => {
    const t = await setup();
    const said: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((s: string) => { said.push(String(s)); return true; }) as typeof process.stderr.write;
    try {
      expect(await runCreateCommand('projects', ['add', '--json'], clone(), t.deps, t.out)).toBe(1);
      expect(await runCreateCommand('projects', ['add', '--json'], clone({ trusted: true }), t.deps, t.out)).toBe(1);
    } finally { process.stderr.write = write; }
    expect(said.join('')).toMatch(/--trust-code/);
    expect(t.made).toEqual([]);
    expect(listClients(t.clientsFile)).toEqual([]);
  });

  it('7. with --trust-code: cloned, the trust given by the operator\'s client', async () => {
    const t = await setup();
    expect(await runCreateCommand('projects', ['add', '--json', '--trust-code'], clone(), t.deps, t.out)).toBe(0);
    expect(t.made).toEqual([['project', 'repo', { kind: 'git', url: 'https://github.com/a/b', trusted: true, by: 'tars-server cli' }]]);
    expect(await runCreateCommand('projects', ['add', '--json'], JSON.stringify({ name: 'blank', from: { kind: 'empty' } }), t.deps, t.out)).toBe(0);
  });
});

describe('tars-server projects add | agents add', () => {
  it('3, 4. projects add: through the door, its answer printed, the operator\'s client gone after', async () => {
    const t = await setup();
    expect(await runCreateCommand('projects', ['add', '--json'], JSON.stringify({ name: 'new-one', from: { kind: 'empty' } }), t.deps, t.out)).toBe(0);
    expect(JSON.parse(t.lines[0])).toEqual({ ok: true, project: { name: 'new-one', path: '/home/tars/projects/new-one' } });
    expect(t.made).toEqual([['project', 'new-one', { kind: 'empty' }]]);
    expect(listClients(t.clientsFile)).toEqual([]);
  });

  it('3, 4. agents add: through the door, in one of the server\'s projects', async () => {
    const t = await setup();
    expect(await runCreateCommand('agents', ['add'], JSON.stringify({ projectName: 'test-cloud', name: 'Test cloud', provider: 'claude', model: 'haiku' }), t.deps, t.out)).toBe(0);
    expect(JSON.parse(t.lines[0])).toMatchObject({ ok: true, agent: { id: 'a-new', name: 'Test cloud' } });
    expect(t.made).toEqual([['agent', { projectPath: '/home/tars/projects/test-cloud', name: 'Test cloud', provider: 'claude', model: 'haiku' }]]);
    expect(listClients(t.clientsFile)).toEqual([]);
  });

  it('4, 5. a refusal exits 1, says its sentence, and leaves no client', async () => {
    const t = await setup();
    expect(await runCreateCommand('projects', ['add'], JSON.stringify({ name: 'taken', from: { kind: 'empty' } }), t.deps, t.out)).toBe(1);
    expect(t.lines).toEqual([]);
    expect(listClients(t.clientsFile)).toEqual([]);
  });

  it('1. the input on stdin only, a JSON object', async () => {
    const t = await setup();
    expect(await runCreateCommand('projects', ['add', '{"name":"x","from":{"kind":"empty"}}'], '', t.deps, t.out)).toBe(1);
    expect(await runCreateCommand('projects', ['add'], 'not json', t.deps, t.out)).toBe(1);
    expect(t.made).toEqual([]);
    expect(listClients(t.clientsFile)).toEqual([]);
  });

  it('2. the server not running: refused, nothing written, no client', async () => {
    const t = await setup();
    expect(await runCreateCommand('agents', ['add'], JSON.stringify({ projectName: 'test-cloud', name: 'x' }), { ...t.deps, serverRunning: () => false }, t.out)).toBe(1);
    expect(t.made).toEqual([]);
    expect(fs.existsSync(t.clientsFile) ? listClients(t.clientsFile) : []).toEqual([]);
  });

  it('6. an unknown verb is usage, exit 2', async () => {
    const t = await setup();
    expect(await runCreateCommand('agents', ['remove'], '', t.deps, t.out)).toBe(2);
  });
});
