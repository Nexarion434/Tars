import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A CLI run inside an agent's own terminal does not take the agent's session.
 *
 * Measured on 2026-10-13 (claude 2.1.296): an agent ran `claude -p "reply with
 * the word ok"` from its Bash tool. The nested claude inherited the agent's
 * CLAUDE_AGENT_ID, its token and Tars's hooks: its SessionStart registered it
 * as the agent's session, its Stop marked the agent done with "ok", the real
 * session's posts were then dropped as stale, and a restart would have resumed
 * the nested conversation. Claude Code hands its hooks CLAUDE_PID, its own pid
 * (the nested claude's hook saw the nested pid): Tars registers a session only
 * from the CLI that is its terminal's process, or that process's child.
 *
 * The CLIs are stand-ins named `claude` that run Tars's own hook scripts from
 * hooks/ as Claude Code does, CLAUDE_PID included. The agent's stand-in, told
 * NEST, runs a second stand-in from a shell, as the Bash tool does, which
 * starts a session, answers "ok" and exits.
 * Asserted: the agent's session, the session a restart resumes and its last
 * output are the agent's own, before and after the nested run. And (the
 * Audit's L5 on #380) when the agent's own SessionStart was lost, so that it
 * has no session at all, the nested run's turn and Stop change nothing either:
 * not its session, not its status, not its last output.
 * The artefact: values.json with both sessions and the agent as Tars holds it.
 */

type Agent = { id: string; status: string; currentSessionId?: string; resumableSessionId?: string; lastCleanOutput?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]>; sendInput(p: { id: string; input: string }): Promise<unknown> } } };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
// What Claude Code does: its own pid, for its hooks and everything it starts.
process.env.CLAUDE_PID = String(process.pid);
const args = process.argv.slice(2);
const nested = args.includes('-p');
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
fs.writeFileSync(transcript, '');
const record = (o) => fs.appendFileSync(path.join(process.env.HOME, 'cli.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, nested, sid, ...o }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
// The agent's own SessionStart lost (the API down at its boot), when the test says so.
if (nested || !fs.existsSync(path.join(process.env.HOME, 'lose-session-start'))) hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
record({ event: 'started' });
if (nested) {
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) + '\n');
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok' });
  record({ event: 'stopped' });
  process.exit(0);
}
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf('\r')) !== -1) {
    const typed = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (typed.includes('NEST')) {
      // As the Bash tool runs it: a shell, then the CLI, the agent's whole environment inherited.
      const run = spawnSync('/bin/sh', ['-c', '"$0" -p "reply with the word ok"', process.argv[1]], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, timeout: 60000 });
      record({ event: 'nested-done', status: run.status });
    }
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a CLI run inside an agent's terminal does not take the agent's session", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-nested-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'w', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const events = () => lines(path.join(home, 'cli.jsonl'));
  const values: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31452), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const worker = async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'w')!;

    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'w', prompt: '' }));
    await expect.poll(() => events().find((e) => !e.nested && e.event === 'started')?.sid ?? null, { timeout: 60_000 }).not.toBeNull();
    const own = events().find((e) => !e.nested && e.event === 'started').sid as string;
    await expect.poll(async () => (await worker()).currentSessionId ?? null, { timeout: 60_000 }).toBe(own);
    values.before = { own, agent: await worker() };

    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'w', input: 'NEST\r' }));
    await expect.poll(() => events().some((e) => e.event === 'nested-done'), { timeout: 90_000 }).toBe(true);
    const nestedSid = events().find((e) => e.nested && e.event === 'started')?.sid as string | undefined;
    expect(nestedSid, 'the nested CLI started a session of its own').toBeTruthy();
    // Its posts are on their way or done: give the API what the hooks sent.
    await page.waitForTimeout(1_500);
    const after = await worker();
    values.after = { own, nested: nestedSid, agent: after, events: events() };
    recordValues(values);

    expect(after.currentSessionId, "the agent's session stays its own").toBe(own);
    expect(after.resumableSessionId, 'a restart resumes its own conversation').toBe(own);
    expect(after.lastCleanOutput ?? null, "the nested CLI's answer is not the agent's").not.toBe('ok');
  } finally {
    await app.close();
  }
});

test("a CLI run inside an agent's terminal drives nothing when the agent's own session start was lost", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-nested-lost-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'lose-session-start'), '');
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'w', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const events = () => lines(path.join(home, 'cli.jsonl'));
  const values: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31440), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const worker = async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'w')!;

    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'w', prompt: '' }));
    await expect.poll(() => events().some((e) => !e.nested && e.event === 'started'), { timeout: 60_000 }).toBe(true);
    // Its status settled from the launch, with no session of its own.
    await page.waitForTimeout(2_000);
    const before = await worker();
    values.before = before;
    expect(before.currentSessionId ?? null, 'the stand-in lost its own SessionStart').toBeNull();

    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'w', input: 'NEST\r' }));
    await expect.poll(() => events().some((e) => e.event === 'nested-done'), { timeout: 90_000 }).toBe(true);
    await page.waitForTimeout(1_500);
    const after = await worker();
    values.after = { agent: after, events: events() };
    recordValues(values);

    expect(after.currentSessionId ?? null, 'the nested CLI took the session').toBeNull();
    expect(after.status, "the nested CLI's Stop changed the agent's status").toBe(before.status);
    expect(after.lastCleanOutput ?? null, "the nested CLI's answer is not the agent's").not.toBe('ok');
  } finally {
    await app.close();
  }
});
