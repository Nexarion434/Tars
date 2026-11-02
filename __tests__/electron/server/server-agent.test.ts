import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFakeClis } from '../../../e2e/fake-clis.mjs';

/**
 * M1's proof (plan Task 8): a Tars server under plain Node, its agent a real
 * PTY on the recording fake claude, driven by a client through the door as a
 * desktop will through its SSH forward. Start it, watch its stream, type into
 * it, message it, stop it with a reason, revoke the client.
 *
 * How it fails:
 * - the agent not starting from the door, or its fleet saying the CLI is not
 *   running once it is
 * - the stream not carrying what the agent's terminal shows
 * - keys not reaching the CLI as typed; a message reaching it without the
 *   client's sender line before it
 * - the stop not filed under "<client> (machine)" with its reason
 * - a revoked client's stream kept open, or its next request answered
 */

const ROOT = path.resolve(__dirname, '../../..');
const ENTRY = path.join(ROOT, 'electron', 'dist', 'server', 'main.js');
const CLI = path.join(ROOT, 'electron', 'dist', 'server', 'cli.js');
const GUARD = path.join(ROOT, '__tests__', 'fixtures', 'no-electron.cjs');
const HOME = os.homedir();

let child: ChildProcess | null = null;
afterEach(async () => {
  const running = child;
  child = null;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const gone = new Promise(resolve => running.once('exit', resolve));
  running.kill('SIGKILL');
  await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 10_000))]);
  await new Promise(resolve => setTimeout(resolve, 500));
});

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'electron', 'tsconfig.json')], { stdio: 'pipe' });
}, 300_000);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function seed(): { project: string; log: string } {
  const project = path.join(HOME, 'projects', 'demo');
  const dir = path.join(HOME, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(HOME, ['claude']) as Record<string, string>;
  // Windows starts no extensionless script (LaunchError): an npm-style shim beside it, of the form
  // platform/cli-binary.ts reads (cmd-shim before 5), runs it on node.
  if (process.platform === 'win32') {
    fs.copyFileSync(fakes.claude, `${fakes.claude}.js`);
    const shim = `${fakes.claude}.cmd`;
    fs.writeFileSync(shim, `@node  "%~dp0\\claude.js" %*\r\n`);
    fakes.claude = shim;
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'nova', name: 'Nova', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'bypass', cliPath: fakes.claude, createdAt: '2026-11-02T08:00:00.000Z', lastActivity: '2026-11-02T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    cliPaths: { claude: fakes.claude, additionalPaths: [path.join(HOME, 'bin')] },
  }));
  return { project, log: path.join(HOME, 'fake-cli.jsonl') };
}

async function boot(port: number): Promise<() => string> {
  let output = '';
  child = spawn(process.execPath, ['-r', GUARD, ENTRY], {
    cwd: os.tmpdir(),
    env: { ...process.env, DOROTHY_API_PORT: String(port), XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'tars-state-')), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', c => { output += String(c); });
  child.stderr!.on('data', c => { output += String(c); });
  const deadline = Date.now() + 120_000;
  const markers = ['App initialization complete', 'Agent API server running on', '[cloud] door on 127.0.0.1:'];
  while (!markers.every(m => output.includes(m))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`no boot (exit ${child.exitCode}):\n${output.slice(-3000)}`);
    await new Promise(r => setTimeout(r, 250));
  }
  return () => output;
}

function call(port: number, method: string, urlPath: string, credential: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function openStream(port: number, credential: string): { text: () => string; ended: () => boolean; close: () => void } {
  let text = '';
  let ended = false;
  const req = http.get({ host: '127.0.0.1', port, path: '/cloud/v1/agents/nova/stream', headers: { Authorization: `Bearer ${credential}` } }, res => {
    res.on('data', c => { text += c; });
    res.on('end', () => { ended = true; });
    res.on('close', () => { ended = true; });
  });
  req.on('error', () => { ended = true; });
  return { text: () => text, ended: () => ended, close: () => req.destroy() };
}

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise(r => setTimeout(r, 300));
  }
}

const nova = async (door: number, credential: string) =>
  ((await call(door, 'GET', '/cloud/v1/fleet', credential)).json.agents as Array<Record<string, unknown>> | undefined)?.find(a => a.agentId === 'nova');
const typedLines = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as { typed?: string }; } catch { return {}; } }).map(r => r.typed).filter((t): t is string => typeof t === 'string') : []);

// POSIX only: a Tars server runs on Linux, and Windows does not start these stand-ins from a PTY (the base's
// Windows E2E fails the same way on qwen and gemini). The ubuntu CI job runs it.
describe.skipIf(process.platform === 'win32')('a client drives a real agent on a Tars server', () => {
  it('starts it, sees it, types into it, messages it, stops it, and is revoked', async () => {
    const { log } = seed();
    const port = await freePort();
    const env = { ...process.env, DOROTHY_API_PORT: String(port) };
    const minted = JSON.parse(execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], { input: JSON.stringify({ name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] }), env }).toString());
    await boot(port);
    const door = port + 2;
    const credential = minted.credential as string;

    expect(await nova(door, credential)).toMatchObject({ agentId: 'nova', cliRunning: false });
    const started = await call(door, 'POST', '/cloud/v1/agents/nova/start', credential, {});
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    await until(() => nova(door, credential), a => a?.cliRunning === true, 60_000, 'the CLI to run');

    const stream = openStream(door, credential);
    // As a person types: the words, then the Enter. Text and Enter in one chunk are a paste to the CLI, which
    // submits nothing inside a paste (measured on the ubuntu runner: the stream echoed the line, nothing ran).
    expect((await call(door, 'POST', '/cloud/v1/agents/nova/keys', credential, { data: 'ECHO alpha' })).status).toBe(200);
    expect((await call(door, 'POST', '/cloud/v1/agents/nova/keys', credential, { data: '\r' })).status).toBe(200);
    await until(() => typedLines(log), lines => lines.some(l => l.includes('ECHO alpha')), 30_000, 'the keys in the CLI').catch(err => { throw new Error(err.message + ' LOG=' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').slice(-1500) : 'none') + ' STREAM=' + stream.text().slice(-1500)); });
    await until(() => stream.text(), t => t.includes('echo alpha'), 30_000, 'the answer in the stream');

    expect((await call(door, 'POST', '/cloud/v1/agents/nova/message', credential, { text: 'ECHO beta' })).status).toBe(200);
    const withLine = await until(() => typedLines(log), lines => lines.some(l => l.includes('ECHO beta')), 30_000, 'the message in the CLI');
    expect(withLine.find(l => l.includes('ECHO beta'))).toContain('Message from the machine "Mac": ');

    expect((await call(door, 'POST', '/cloud/v1/agents/nova/stop', credential, { reason: 'done for today' })).status).toBe(200);
    expect(await until(() => nova(door, credential), a => a?.cliRunning === false && a?.stoppedBy !== undefined, 30_000, 'the stop')).toMatchObject({ stoppedBy: 'Mac (machine)', stopReason: 'done for today' });

    execFileSync(process.execPath, [CLI, 'clients', 'revoke', minted.id], { env });
    await until(() => stream.ended(), e => e, 5_000, 'the stream to end');
    expect((await call(door, 'GET', '/cloud/v1/fleet', credential)).status).toBe(401);
  }, 240_000);

  // Review Focus 1: a systemd restart or an update. As at a desktop's relaunch, an agent at rest stays at rest
  // (restart recovery resumes only the agents that were mid-turn): it is still there, and its CLI comes back,
  // by recovery or by the client's start, and takes a message again.
  it('keeps its agent across a SIGTERM and a new serve, and drives it again', async () => {
    const { log } = seed();
    const port = await freePort();
    const env = { ...process.env, DOROTHY_API_PORT: String(port) };
    const minted = JSON.parse(execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], { input: JSON.stringify({ name: 'Mac', kind: 'desktop', scopes: ['see', 'drive'] }), env }).toString());
    const credential = minted.credential as string;
    const door = port + 2;
    await boot(port);
    expect((await call(door, 'POST', '/cloud/v1/agents/nova/start', credential, {})).status).toBe(200);
    await until(() => nova(door, credential), a => a?.cliRunning === true, 60_000, 'the CLI to run');

    const first = child!;
    const exited = new Promise<number | null>(resolve => first.once('exit', code => resolve(code)));
    first.kill('SIGTERM');
    expect(await Promise.race([exited, new Promise<string>(r => setTimeout(() => r('still running'), 30_000))])).toBe(0);

    await boot(port);
    expect(await nova(door, credential)).toMatchObject({ agentId: 'nova', name: 'Nova' });
    const back = await until(() => nova(door, credential), a => a?.cliRunning === true, 15_000, 'recovery').catch(() => null);
    if (!back) {
      const started = await call(door, 'POST', '/cloud/v1/agents/nova/start', credential, {});
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      await until(() => nova(door, credential), a => a?.cliRunning === true, 60_000, 'the CLI to run again');
    }
    expect((await call(door, 'POST', '/cloud/v1/agents/nova/message', credential, { text: 'ECHO gamma' })).status).toBe(200);
    const lines = await until(() => typedLines(log), l => l.some(t => t.includes('ECHO gamma')), 30_000, 'the message after the restart');
    expect(lines.find(t => t.includes('ECHO gamma'))).toContain('Message from the machine "Mac": ');
  }, 300_000);
});
