import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Receipts, send modes, the ceiling for delegated runs, and delegated results
 * that survive a restart (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 items 1 to 4; PR B,
 * the proof of row B), in the real app.
 *
 * Stand-in CLIs record every byte typed into them. Requests go through the API
 * with each asker's own token, as the MCP tools send them; a worker's turns are
 * told through the hook route with its own token, as Claude Code's hooks do.
 * An ACP run goes to a fake ACP agent launched as `opencode acp`, which records
 * the session mode Tars asks for.
 *
 * Asserted:
 * 1. one clientRequestId sent three times (two at once, one after): one batch
 *    of keystrokes, one request queued, one task in the ledger, and the two
 *    retries answered with the first outcome;
 * 2. the same id with another text: `clientRequestId_conflict`, nothing typed;
 * 3. the receipts file, in ~/.tars-private, holds the id and none of the text;
 * 4. `steer` into a codex worker: `not_steerable`, nothing typed;
 * 5. `steer` into a worker busy with another asker's work: refused;
 * 6. `queue` into a worker in a turn: nothing typed until the turn ends;
 * 7. an ACP run asked by an agent in plan mode, of a target in bypass, runs
 *    in plan; asked by an agent in bypass, it runs in bypass;
 * 8. a message from an agent in plan mode to a worker in bypass is marked so;
 * 9. after a relaunch, the run's result is read from the ledger by its id, and
 *    by the clientRequestId it was sent with; another agent reads nothing.
 * The artefact: values.json with every answer, the bytes each stand-in
 * received, the ledger's tasks, and the receipts file itself.
 */

type Agent = { id: string; cliRunning?: boolean };
type Task = { id: string; agentId: string; requesterAgentId: string | null; source: string; outcome: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> };
  usage: { tasks(p: { sinceDays: number }): Promise<{ tasks: Task[] }> };
} };
type Answer = { status: number; body: Record<string, unknown> };

const STAND_IN = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
  "process.stdout.write('stand-in ready\\n');",
  '',
].join('\n');

/** A fake ACP agent: one session offering four modes, each set_mode recorded, one turn that answers "reviewed". */
const FAKE_ACP = (modesFile: string) => String.raw`
const fs = require('fs');
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-1', modes: {
    currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'acceptEdits' }, { id: 'plan' }, { id: 'bypassPermissions' }],
  } } });
  if (msg.method === 'session/set_mode') {
    fs.appendFileSync(${JSON.stringify(modesFile)}, msg.params.modeId + '\n');
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reviewed' } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 100 } } });
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
}
process.stdin.resume();
`;

function sandbox(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const received = (id: string) => path.join(home, `${id}.received`);
  const cliFor = (id: string) => {
    const cli = path.join(home, `${id}-cli.cjs`);
    fs.writeFileSync(cli, STAND_IN(received(id)), { mode: 0o755 });
    return cli;
  };
  const read = (id: string) => (fs.existsSync(received(id)) ? fs.readFileSync(received(id), 'utf8') : '');
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'auto',
    projectPath: project, skills: [], cliPath: cliFor(id),
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  const seed = (agents: object[], settings: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', ...settings }));
  };
  return { home, project, dir, bin, read, agent, seed };
}

async function open(home: string, port: string, ids: string[]) {
  const dist = path.resolve('electron', 'dist');
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
  for (const id of ids) {
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
    await expect.poll(async () => (await list()).find(a => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
  }
  /** Each stand-in's session up (it has no hooks), at rest, and a token for each agent named. */
  const tokensFor = (all: string[]) => app.evaluate((_e, { dist, ids, all }) => {
    const req = process.mainModule!.require;
    const { agents } = req(`${dist}/core/agent-manager.js`);
    const tokens: Record<string, string> = {};
    for (const id of all) {
      const a = agents.get(id);
      if (ids.includes(id)) { a.sessionRegisteredAt = new Date().toISOString(); a.status = 'idle'; }
      tokens[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
    }
    return tokens;
  }, { dist, ids, all });
  const tasks = () => page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 })).then(r => r.tasks);
  return { app, page, dist, tokensFor, tasks };
}

function client(port: string, tokens: () => Record<string, string>) {
  const call = (method: 'GET' | 'POST', route: string, as: string, body?: Record<string, unknown>): Promise<Answer> =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens()[as]}`, 'X-Tars-Caller-Id': as },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
  return { post: (route: string, as: string, body: Record<string, unknown>) => call('POST', route, as, body), get: (route: string, as: string) => call('GET', route, as) };
}

const count = (text: string, marker: string) => text.split(marker).length - 1;

test('a retried request is sent once, a reused id with another text is refused, and the send modes hold', async () => {
  test.setTimeout(300_000);
  const s = sandbox('tars-e2e-receipts-');
  s.seed([
    s.agent('w1', 'Worker'), s.agent('o1', 'Lead'), s.agent('b1', 'Bot'),
    s.agent('cx', 'Codex Worker', { provider: 'codex' }),
  ]);
  const port = apiPort(31455);
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const step = (name: string) => { times[name] = Date.now() - t0; };
  const { app, tokensFor, tasks } = await open(s.home, port, ['w1', 'o1', 'b1', 'cx']);
  step('opened');
  const values: Record<string, unknown> = { times };
  try {
    const tokens = await tokensFor(['w1', 'o1', 'b1', 'cx']);
    const { post } = client(port, () => tokens);
    const session = 'e2e00000-0000-4000-8000-0000000000b1';
    const hook = (body: Record<string, unknown>) => post('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: session, ...body });
    await hook({ status: 'idle', source: 'startup' });

    // 1. One id, three sends: two at once, as a timeout and its retry overlap, then a third.
    const send = { message: 'RCPT-ALPHA review #280', clientRequestId: 'cr-e2e-0001' };
    const [first, second] = await Promise.all([post('/api/agents/w1/dispatch', 'o1', send), post('/api/agents/w1/dispatch', 'o1', send)]);
    const third = await post('/api/agents/w1/dispatch', 'o1', send);
    step('sent3');
    await expect.poll(() => s.read('w1').includes('RCPT-ALPHA'), { timeout: 20_000 }).toBe(true);
    // Time for a second batch to land, were one on its way.
    await new Promise(r => setTimeout(r, 3_000));
    const typed = s.read('w1').split(/\r|\n|\x1b\[20[01]~/).find(l => l.includes('RCPT-ALPHA')) ?? '';
    const worker = () => app.evaluate((_e, { dist }) => {
      const w = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1');
      return { queue: (w.taskQueue ?? []).map((r: { ref: string; requesterAgentId: string }) => [r.ref, r.requesterAgentId]), requestedBy: w.requestedBy ?? null };
    }, { dist: path.resolve('electron', 'dist') });
    values.retried = { first, second, third, typed, alphaTyped: count(s.read('w1'), 'RCPT-ALPHA'), worker: await worker() };
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(count(s.read('w1'), 'RCPT-ALPHA')).toBe(1);
    const answers = [first.body, second.body, third.body];
    expect(answers.filter(a => a.duplicate === true)).toHaveLength(2);
    expect(new Set(answers.map(a => a.taskRef)).size).toBe(1);
    expect((await worker()).queue).toEqual([[first.body.taskRef ?? second.body.taskRef, 'o1']]);

    // Its turn: one task in the ledger, asked by o1.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: typed });
    await expect.poll(async () => (await tasks()).filter(t => t.agentId === 'w1').length, { timeout: 10_000 }).toBe(1);
    step('ledger');

    // 5. Steer into a worker busy with another asker's work.
    const busy = await post('/api/agents/w1/dispatch', 'b1', { message: 'RCPT-STEER-OTHER stop that', mode: 'steer' });
    values.steerOther = busy;
    step('steerOther');
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('worker_busy_for_other_requester');

    // 6. Queue into the worker in its turn: nothing typed until the turn ends.
    const queued = await post('/api/agents/w1/dispatch', 'b1', { message: 'RCPT-GAMMA after you', mode: 'queue' });
    await new Promise(r => setTimeout(r, 2_500));
    const gammaDuringTurn = count(s.read('w1'), 'RCPT-GAMMA');
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => count(s.read('w1'), 'RCPT-GAMMA'), { timeout: 15_000 }).toBe(1);
    step('queued');
    values.queued = { answer: queued, gammaDuringTurn };
    expect(queued.status).toBe(200);
    expect(queued.body.queued).toBe(true);
    expect(gammaDuringTurn).toBe(0);

    // 2. The same id, another text.
    const conflict = await post('/api/agents/w1/dispatch', 'o1', { message: 'RCPT-BETA something else', clientRequestId: 'cr-e2e-0001' });
    await new Promise(r => setTimeout(r, 1_500));
    values.conflict = conflict;
    step('conflict');
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('clientRequestId_conflict');
    expect(s.read('w1')).not.toContain('RCPT-BETA');

    // 4. Steer into a CLI Tars cannot interrupt.
    const steer = await post('/api/agents/cx/dispatch', 'o1', { message: 'RCPT-STEER-CODEX now', mode: 'steer' });
    await new Promise(r => setTimeout(r, 1_500));
    values.steerCodex = steer;
    step('steerCodex');
    expect(steer.status).toBe(409);
    expect(steer.body.code).toBe('not_steerable');
    expect(s.read('cx')).not.toContain('RCPT-STEER-CODEX');

    // 3. The receipts: in ~/.tars-private, the id, none of the text.
    const receipts = path.join(s.home, '.tars-private', 'request-receipts.jsonl');
    const raw = fs.existsSync(receipts) ? fs.readFileSync(receipts, 'utf8') : '';
    fs.writeFileSync(test.info().outputPath('request-receipts.jsonl'), raw);
    values.receipts = { lines: raw.split('\n').filter(Boolean).length, mode: fs.existsSync(receipts) ? (fs.statSync(receipts).mode & 0o777).toString(8) : null };
    expect(raw).toContain('cr-e2e-0001');
    expect(raw).not.toMatch(/RCPT-|review #280|after you/);
    expect(fs.statSync(receipts).mode & 0o777).toBe(0o600);
    values.ledger = await tasks();
  } finally {
    values.received = { w1: s.read('w1'), cx: s.read('cx') };
    recordValues(values);
    await app.close();
  }
});

test('a delegated run takes the narrower mode of its asker, a narrower sender is marked, and its result outlives a relaunch', async () => {
  test.setTimeout(300_000);
  const s = sandbox('tars-e2e-ceiling-');
  const modes = path.join(s.home, 'acp-modes.log');
  fs.writeFileSync(path.join(s.bin, 'opencode'), `#!${process.execPath}\n${FAKE_ACP(modes)}`, { mode: 0o755 });
  s.seed([
    s.agent('p1', 'Planner', { permissionMode: 'plan' }),
    s.agent('by', 'Builder', { permissionMode: 'bypass' }),
    s.agent('wb', 'Bypass Worker', { permissionMode: 'bypass' }),
    s.agent('oc', 'Review Agent', { provider: 'opencode', permissionMode: 'bypass' }),
  ], { cliPaths: { additionalPaths: [s.bin] } });
  fs.writeFileSync(path.join(s.dir, 'acp-registry.json'), JSON.stringify({ fetchedAt: Date.now(), agents: { opencode: { id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] } } }));
  const port = apiPort(31454);
  const values: Record<string, unknown> = {};
  const modesSet = () => (fs.existsSync(modes) ? fs.readFileSync(modes, 'utf8').split('\n').filter(Boolean) : []);

  let opened = await open(s.home, port, ['p1', 'by', 'wb']);
  let taskId = '';
  try {
    let tokens = await opened.tokensFor(['p1', 'by', 'wb', 'oc']);
    const { post } = client(port, () => tokens);

    // 7. Asked from plan mode: the run is in plan.
    const planned = await post('/api/agents/oc/run-task', 'p1', { task: 'ACP-PLAN review the notes', timeoutSeconds: 60, clientRequestId: 'cr-acp-plan-1' });
    const afterPlan = modesSet();
    // Asked from bypass mode: the run is in bypass.
    const bypassed = await post('/api/agents/oc/run-task', 'by', { task: 'ACP-BYPASS review the notes', timeoutSeconds: 60 });
    const afterBypass = modesSet();
    values.runs = { planned, bypassed, afterPlan, afterBypass };
    expect(planned.status).toBe(200);
    expect(planned.body.ok).toBe(true);
    expect(afterPlan.at(-1)).toBe('plan');
    expect(bypassed.status).toBe(200);
    expect(afterBypass.at(-1)).toBe('bypassPermissions');
    taskId = String(planned.body.taskId ?? '');
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // 8. A message from plan mode to a worker in bypass carries the mark.
    const marked = await post('/api/agents/wb/dispatch', 'p1', { message: 'MARK-ME build it' });
    await expect.poll(() => s.read('wb').includes('MARK-ME'), { timeout: 20_000 }).toBe(true);
    const line = s.read('wb').split(/\r|\n|\x1b\[20[01]~/).find(l => l.includes('MARK-ME')) ?? '';
    values.marked = { answer: marked, line };
    expect(line).toMatch(/^Message from agent "Planner" \("p1"\), task t-[0-9a-f]{8}: \(sender in plan mode, you in bypass mode\) MARK-ME build it$/);
  } finally {
    await opened.app.close();
  }

  // 9. Relaunched: the result is read from the ledger.
  opened = await open(s.home, port, []);
  try {
    const tokens = await opened.tokensFor(['p1', 'by']);
    const { get } = client(port, () => tokens);
    const byId = await get(`/api/tasks/${taskId}`, 'p1');
    const byRequest = await get('/api/tasks?clientRequestId=cr-acp-plan-1', 'p1');
    const stranger = await get(`/api/tasks/${taskId}`, 'by');
    values.afterRelaunch = { byId, byRequest, stranger };
    expect(byId.status).toBe(200);
    expect(byId.body.task).toMatchObject({ id: taskId, agentId: 'oc', requesterAgentId: 'p1', outcome: 'completed', stopReason: 'end_turn', result: 'reviewed' });
    expect(byRequest.status).toBe(200);
    expect((byRequest.body.task as { id?: string } | undefined)?.id).toBe(taskId);
    expect(stranger.status).toBe(404);
  } finally {
    recordValues(values);
    await opened.app.close();
  }
});
