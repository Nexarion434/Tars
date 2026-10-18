import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A background task that ends during a turn is not reported as still running
 * at that turn's end, in the real app (the Low after the 2.0.0 chain,
 * 2026-10-13: Tars told the Audit, QA, the Backend and the Frontend, at every
 * end of their turns, that tasks finished hours before were still running).
 *
 * Claude Code 2.1.296 records a task's completion that arrives while a turn
 * runs as a queue-operation `enqueue` and an attachment `queued_command`, the
 * `<task-notification>` in each, and no user line: measured on the Backend's
 * own transcript of the night (40 enqueues, 21 attachments, the notices of
 * its background runs). Tars read the notes from user lines only.
 *
 * Two stand-in CLIs record what they are typed: a worker, and "Lead", the
 * project's orchestrator, which asks it for work through the API with its own
 * token, as send_message does.
 * The worker's turns are told to Tars through the real hook route with its own
 * token, and its transcript is written where Claude Code keeps it, in the
 * shapes 2.1.296 writes, trimmed to the fields read.
 *
 * Asserted:
 * 1. a task whose background command ended mid-turn: Lead is told the worker
 *    finished, not that work is still running, and the link is spent;
 * 2. the control: a task whose background command is still running at the
 *    turn's end is told as such, and its link kept.
 * The artefact: values.json with what Lead received and the worker's link.
 */

type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const SESSION = 'e2e00000-0000-4000-8000-0000000b9001';
const notice = (taskId: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_e2e</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep 25" completed (exit code 0)</summary>\n</task-notification>`;

test('a background task that ended during a turn is not reported as still running', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-bg-mid-turn-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const cliFor = (id: string) => {
    const file = path.join(home, `${id}.received`);
    const cli = path.join(home, `${id}-cli.cjs`);
    fs.writeFileSync(cli, [
      `#!${process.execPath}`,
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
      "process.stdout.write('stand-in ready\\n');",
      '',
    ].join('\n'), { mode: 0o755 });
    return { cli, file };
  };
  const stand = { w1: cliFor('w1'), o1: cliFor('o1') };
  const agent = (id: 'w1' | 'o1', name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role,
    projectPath: project, skills: [], cliPath: stand[id].cli,
    createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  });
  // Lead is the project's orchestrator: since 2.0.4 what a worker sends another worker is a note for information,
  // which hands over no task and leaves no link to report on (core/one-task.ts).
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('w1', 'Worker'), agent('o1', 'Lead', 'orchestrator')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // Where Claude Code keeps the worker's transcript: its project's folder, every character but a letter or a digit a dash.
  const transcript = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const write = (...lines: unknown[]) => fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const port = apiPort(31441);
  const dist = path.resolve('electron', 'dist');
  const read = (id: keyof typeof stand) => (fs.existsSync(stand[id].file) ? fs.readFileSync(stand[id].file, 'utf8') : '');
  const values: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    for (const id of ['w1', 'o1']) {
      await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
      await expect.poll(async () => (await list()).find((a) => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    }
    // Each stand-in's session up (it has no hooks), Lead at rest, and a token for each.
    const tokens = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const out: Record<string, string> = {};
      for (const id of ['w1', 'o1']) {
        const a = agents.get(id);
        a.sessionRegisteredAt = new Date().toISOString();
        if (id === 'o1') a.status = 'idle';
        out[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
      }
      return out;
    }, { dist });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const hook = (body: Record<string, unknown>) => api('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: SESSION, ...body });
    const link = () => app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1').requestedBy ?? null, { dist });
    await hook({ status: 'idle', source: 'startup' });

    /** Lead hands the worker a task; the worker takes it as its turn, and runs a command in the background. */
    const task = async (text: string, bgId: string) => {
      const before = read('w1').length;
      const sent = await api('/api/agents/w1/message', 'o1', { message: text });
      expect(sent.status).toBe(200);
      await expect.poll(() => read('w1').slice(before).includes(text), { timeout: 20_000 }).toBe(true);
      const line = read('w1').slice(before).split(/\r|\n|\x1b\[20[01]~/).find((l) => /^Message from/.test(l)) ?? '';
      await hook({ status: 'running', event: 'UserPromptSubmit', current_task: `${line}${text}` });
      const at = new Date().toISOString();
      write(
        { type: 'assistant', timestamp: at, sessionId: SESSION, message: { content: [{ type: 'tool_use', id: `t-${bgId}`, name: 'Bash', input: { command: 'sleep 25', run_in_background: true } }] } },
        { type: 'user', timestamp: at, sessionId: SESSION, toolUseResult: { backgroundTaskId: bgId }, message: { content: [{ type: 'tool_result', tool_use_id: `t-${bgId}`, content: `Command running in background with ID: ${bgId}` }] } },
      );
    };

    // 1. Its background command ends while the turn runs: queued, then attached to the turn, as 2.1.296 records it.
    const leadBefore = read('o1').length;
    await task('TASK-ONE build the docs', 'bdone0001');
    const at = new Date().toISOString();
    write(
      { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: SESSION, content: notice('bdone0001') },
      { type: 'attachment', timestamp: at, sessionId: SESSION, attachment: { type: 'queued_command', prompt: notice('bdone0001'), commandMode: 'task-notification' } },
      { type: 'assistant', timestamp: at, sessionId: SESSION, message: { content: [{ type: 'text', text: 'Docs built.' }] } },
    );
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => read('o1').slice(leadBefore).includes('Worker'), { timeout: 20_000 }).toBe(true);
    const toldOne = read('o1').slice(leadBefore);
    values.one = { told: toldOne, link: await link() };
    recordValues(values);
    expect(toldOne, 'a task that ended mid-turn was reported as still running').not.toContain('background work still running');
    expect(await link(), 'the link was kept for work that had ended').toBeNull();

    // 2. The control: its background command still runs at the turn's end.
    const leadBeforeTwo = read('o1').length;
    await task('TASK-TWO run the long suite', 'bstill0002');
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => read('o1').slice(leadBeforeTwo).includes('Worker'), { timeout: 20_000 }).toBe(true);
    const toldTwo = read('o1').slice(leadBeforeTwo);
    values.two = { told: toldTwo, link: await link() };
    recordValues(values);
    expect(toldTwo).toContain('background work still running');
    expect(toldTwo).toContain('bstill0002');
    expect(await link()).toMatchObject({ agentId: 'o1', backgroundLeft: ['bstill0002'] });
  } finally {
    await app.close();
    removeHome(home);
  }
});
