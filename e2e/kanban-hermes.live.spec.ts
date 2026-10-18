import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import { TARS_TASK_MARK } from '../electron/services/kanban-board';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The agents' kanban on a real Hermes, in the real app (2.0.4). JeanBrasse, 18/10: agents must be able to use the
 * kanban as they please, and Hermes must not think it is up to it to take their tasks.
 *
 * A real Hermes kanban in a throwaway HERMES_HOME (__tests__/fixtures/hermes-kanban-bench.py): its own HTTP router,
 * which the sandbox's connection file names, and its own dispatcher, promotion and decomposer listing, ticking every
 * half second. The real app on a sandbox HOME, and the real kanban MCP server (mcp-kanban/dist/bundle.js), run once
 * per agent with the identity Tars hands that agent, spoken to over stdio as a CLI speaks to it. Dune and Dove, two
 * workers, and Lead, their orchestrator, work on one project, Kit on another. Dove's CLI is a recording stand-in,
 * which the hand-off starts.
 *
 * Asserted:
 * 1. Dune and Dove file, list, read, claim, report on, finish (one with no summary: Hermes 0.21.5 refuses done with
 *    none), release and delete their own tasks, and no tool answers with an error;
 * 2. Kit, of another project, sees none of them, and can neither claim nor delete one;
 * 3. handing a task to another agent is the orchestrator's: Dune's hand-off to Dove is refused by the role rule of
 *    the drive routes (core/one-task.ts, workerOrderRefusal), 403 worker_may_not_order, saying to ask its
 *    orchestrator, and starts nothing; the task Lead hands to Dove reaches Dove: its CLI starts with the task;
 * 4. every task carries Tars's mark in its body, on Hermes itself;
 * 5. over at least six ticks of Hermes's dispatcher after the last write, none of them is spawned, promoted or
 *    listed for decomposition; at no tick does one sit in a state Hermes acts on (todo, triage, running, review,
 *    blocked, or ready on a lane that is not Tars's); the finished ones carry no event of Hermes's own, and the
 *    parked one is still parked.
 *
 * Runs where a Hermes checkout is: TARS_HERMES_TREE (a Hermes source tree, a tag of it) and TARS_HERMES_PYTHON (a
 * python with its dependencies, an install's venv). Skipped elsewhere, the CI included. The artefact: values.json
 * (every tool's answer, Dove's launch, the ticks summed up) and ticks.jsonl, Hermes's own line for each tick.
 */

const TREE = process.env.TARS_HERMES_TREE;
const PYTHON = process.env.TARS_HERMES_PYTHON;
const live = !!TREE && !!PYTHON && fs.existsSync(path.join(TREE, 'hermes_cli'));

const DUNE = 'aaaa1111-0000-4000-8000-0000000000a1';
const DOVE = 'bbbb2222-0000-4000-8000-0000000000b2';
const KIT = 'cccc3333-0000-4000-8000-0000000000c3';
const LEAD = 'dddd4444-0000-4000-8000-0000000000d4';

interface Tick { tick: number; version?: string; spawned?: string[]; triage?: string[]; promoted?: number; tasks?: Record<string, [string, string | null]>; error?: string }
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Answer = { agent: string; tool: string; args: Record<string, unknown>; text: string; isError: boolean };

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('agents use the kanban freely on a real Hermes, and its dispatcher takes none of their tasks', async () => {
  test.skip(!live, 'live: TARS_HERMES_TREE (a Hermes source tree) and TARS_HERMES_PYTHON (its python)');
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-kanban-hermes-'));
  const project = path.join(home, 'projects', 'demo');
  const other = path.join(home, 'projects', 'other');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, other, dir, bin]) fs.mkdirSync(d, { recursive: true });

  // Hermes, its dispatcher ticking.
  const ticksFile = path.join(home, 'ticks.jsonl');
  const hermesPort = await freePort();
  const bench: ChildProcess = spawn(PYTHON!, [path.resolve('__tests__', 'fixtures', 'hermes-kanban-bench.py'), TREE!, path.join(home, 'hermes'), String(hermesPort), ticksFile, '0.5'],
    { cwd: home, stdio: ['ignore', 'ignore', 'pipe'] });
  let benchErr = '';
  bench.stderr?.on('data', (d) => { benchErr = (benchErr + d).slice(-4000); });
  const hermes = `http://127.0.0.1:${hermesPort}`;
  const ticks = (): Tick[] => (fs.existsSync(ticksFile) ? fs.readFileSync(ticksFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

  // Dove's CLI: records how it was started, and stays up as a CLI would.
  const launchesFile = path.join(home, 'launches.jsonl');
  const codexCli = path.join(bin, 'codex');
  fs.writeFileSync(codexCli, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(launchesFile)}, JSON.stringify({ argv: process.argv.slice(2), agent: process.env.CLAUDE_AGENT_ID || null }) + '\\n');
process.stdout.write('codex ready\\r\\n');
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  const launches = () => (fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { argv: string[]; agent: string | null }) : []);

  const agent = (id: string, name: string, provider: string, projectPath: string, role = 'worker') => ({
    id, name, character: 'robot', provider, status: 'idle', role, permissionMode: 'normal', projectPath, skills: [],
    createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(DUNE, 'Dune', 'claude', project), agent(DOVE, 'Dove', 'codex', project), agent(KIT, 'Kit', 'claude', other),
    agent(LEAD, 'Lead', 'claude', project, 'orchestrator'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, other]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, cliPaths: { codex: codexCli }, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: hermesPort, authMode: 'token' }));

  const port = apiPort(31303);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, project, other, hermesPort };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const calls: Answer[] = [];
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  try {
    let version = '';
    for (let i = 0; i < 240 && !version; i++) {
      try {
        const r = await fetch(`${hermes}/api/status`);
        if (r.ok) version = String(((await r.json()) as { version?: string }).version ?? '');
      } catch { /* not up yet */ }
      if (!version) await sleep(250);
    }
    keep({ version });
    expect(version, `Hermes did not answer: ${benchErr}`).toBeTruthy();

    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    await app.firstWindow();
    // What Tars hands each agent's tools: a token naming the agent, and the instance they check before sending it.
    const identity = await app.evaluate((_e, { dist, ids }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { tokens: ids.map((id: string) => tokens.mintRunToken(id).token as string), instance: tokens.tarsInstanceId() as string };
    }, { dist, ids: [DUNE, DOVE, KIT, LEAD] });

    const kanbanAs = async (agentId: string, projectPath: string, token: string) => {
      const mcp = spawn(process.execPath, [path.resolve('mcp-kanban', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token,
          CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: projectPath, TARS_INSTANCE_ID: identity.instance,
        },
      });
      servers.push(mcp);
      const replies = new Map<number, (msg: Reply) => void>();
      let buffered = '';
      mcp.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
        }
      });
      let nextId = 1;
      const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => {
        const id = nextId++;
        replies.set(id, resolve);
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return async (tool: string, args: Record<string, unknown>): Promise<Answer> => {
        const reply = await rpc('tools/call', { name: tool, arguments: args });
        const answer = {
          agent: agentId, tool, args,
          text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error),
          isError: !!reply.result?.isError || !!reply.error,
        };
        calls.push(answer);
        keep({ calls });
        return answer;
      };
    };
    const dune = await kanbanAs(DUNE, project, identity.tokens[0]);
    const dove = await kanbanAs(DOVE, project, identity.tokens[1]);
    const kit = await kanbanAs(KIT, other, identity.tokens[2]);
    const lead = await kanbanAs(LEAD, project, identity.tokens[3]);
    const ok = async (p: Promise<Answer>): Promise<Answer> => {
      const a = await p;
      expect(a.isError, `${a.tool} ${JSON.stringify(a.args)}: ${a.text}`).toBe(false);
      return a;
    };
    const idIn = (a: Answer) => {
      const id = /\[(t_[0-9a-f]+)\]/.exec(a.text)?.[1];
      expect(id, a.text).toBeTruthy();
      return id!;
    };

    // 1. Filed, listed and read.
    const a = idIn(await ok(dune('create_task', { title: 'Measure the board', description: 'First.' })));
    const b = idIn(await ok(dune('create_task', { title: 'Write the spec', description: 'Second.', priority: 'high' })));
    const c = idIn(await ok(dove('create_task', { title: 'Tidy up', description: 'Third.' })));
    const d = idIn(await ok(dove('create_task', { title: 'Left for later', description: 'Fourth, never claimed.' })));
    const listed = await ok(dove('list_tasks', {}));
    for (const id of [a, b, c, d]) expect(listed.text).toContain(id);

    // 2. Another project's agent sees none of them, and can neither claim nor delete one.
    expect((await ok(kit('list_tasks', {}))).text).toBe('No tasks found.');
    const kitClaim = await kit('assign_task', { task_id: a });
    const kitDelete = await kit('delete_task', { task_id: d });
    expect(kitClaim.isError).toBe(true);
    expect(kitClaim.text).toContain(`No task "${a}" in this project`);
    expect(kitDelete.isError).toBe(true);

    // Claimed, reported on, read by the other agent, finished: one with no summary.
    expect((await ok(dune('assign_task', { task_id: a }))).text).toContain('is yours now');
    expect((await ok(dove('assign_task', { task_id: b }))).text).toContain('is yours now');
    expect((await dove('assign_task', { task_id: a })).isError).toBe(true);
    await ok(dune('update_task_progress', { task_id: a, progress: 60 }));
    const read = await ok(dove('get_task', { task_id: a }));
    expect(read.text).toContain('Progress: 60%');
    // Soft, as the body checks below: on a build without the mark, the run goes on and says what else fails.
    expect.soft(read.text, "Tars's mark, as an agent reads the task").toContain(TARS_TASK_MARK);
    expect((await ok(dune('mark_task_done', { task_id: a, summary: '' }))).text).toContain('is done');
    // Released, claimed by the other agent, finished with a summary.
    await ok(dove('move_task', { task_id: b, column: 'backlog' }));
    await ok(dune('assign_task', { task_id: b }));
    await ok(dune('mark_task_done', { task_id: b, summary: 'Spec written.' }));

    // 3. A worker's hand-off is refused, starts nothing and leaves the task unclaimed (the QA's probe of #452 with #449).
    const workerHandOff = await dune('assign_task', { task_id: c, agent_id: DOVE });
    const workerClaim = await fetch(`http://127.0.0.1:${port}/api/kanban/tasks/${c}/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.tokens[0]}` }, body: JSON.stringify({ agent_id: DOVE }),
    }).then(async (r) => ({ status: r.status, body: await r.json() as { code?: string; error?: string } }));
    keep({ workerHandOff, workerClaim });
    expect(workerHandOff.isError, workerHandOff.text).toBe(true);
    expect(workerHandOff.text).toContain('A worker does not hand work to another agent');
    expect(workerHandOff.text).toContain('Ask your orchestrator');
    expect(workerClaim, JSON.stringify(workerClaim)).toMatchObject({ status: 403, body: { code: 'worker_may_not_order' } });
    await sleep(1500);
    expect(launches().filter(l => l.agent === DOVE).length, 'a refused hand-off started Dove').toBe(0);
    expect((await ok(dove('get_task', { task_id: c }))).text, 'the refused hand-off left the task unclaimed').toContain('Held by: nobody');
    // Handed to Dove by the project's orchestrator: claimed on its lane, and its CLI starts with the task.
    expect((await ok(lead('assign_task', { task_id: c, agent_id: DOVE }))).text).toContain('Tars types it into that agent');
    await expect.poll(() => launches().filter(l => l.agent === DOVE && l.argv.join(' ').includes(c)).length, { timeout: 30_000 }).toBe(1);
    keep({ launches: launches() });
    // Dove's own now: it can release and delete it, and Dune, who no longer holds it, cannot delete it.
    expect((await dune('delete_task', { task_id: c })).isError).toBe(true);
    await ok(dove('move_task', { task_id: c, column: 'backlog' }));
    await ok(dove('delete_task', { task_id: c }));

    // 5. Several ticks after the last write, so that "nothing taken" means something.
    const lastWrite = ticks().at(-1)?.tick ?? 0;
    await expect.poll(() => ticks().at(-1)?.tick ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(lastWrite + 6);
    const seen = ticks();
    const ours = [a, b, c, d];
    const taken = seen.flatMap(t => [...(t.spawned ?? []), ...(t.triage ?? [])]).filter(id => ours.includes(id));
    const exposed = seen.flatMap(t => Object.entries(t.tasks ?? {})
      .filter(([id]) => ours.includes(id))
      .filter(([, [status, lane]]) => ['todo', 'triage', 'running', 'review', 'blocked'].includes(status) || (status === 'ready' && !(lane ?? '').startsWith('tars:')))
      .map(([id, s]) => ({ tick: t.tick, id, s })));
    const promoted = seen.reduce((n, t) => n + (t.promoted ?? 0), 0);
    // A tick that failed on the database proved nothing either way (0.21.5 can race its own WAL as it starts).
    const failedAfter = seen.filter(t => t.tick > lastWrite && t.error);
    keep({ ticks: { count: seen.length, lastWriteTick: lastWrite, versions: [...new Set(seen.map(t => t.version))], taken, exposed, promoted, failedAfter } });
    expect(failedAfter).toEqual([]);
    expect(taken).toEqual([]);
    expect(exposed).toEqual([]);
    expect(promoted).toBe(0);

    // 4. On Hermes itself: Tars's mark in every body, the finished ones done with no event of Hermes's own, the
    // parked one still parked on Tars's lane, the deleted one gone.
    const finals: Record<string, unknown> = {};
    for (const id of [a, b, d]) {
      const r = await fetch(`${hermes}/api/plugins/kanban/tasks/${id}`);
      expect(r.status).toBe(200);
      const detail = await r.json() as { task: { status: string; body: string; assignee: string | null }; events?: Array<{ kind: string }> };
      finals[id] = { status: detail.task.status, assignee: detail.task.assignee, events: (detail.events ?? []).map(e => e.kind) };
      expect.soft(detail.task.body, `Tars's mark in ${id}'s body on Hermes`).toContain(TARS_TASK_MARK);
      expect((detail.events ?? []).map(e => e.kind).filter(k => ['promoted', 'claimed', 'spawned', 'decomposed'].includes(k))).toEqual([]);
    }
    keep({ finals });
    expect(finals[a]).toMatchObject({ status: 'done' });
    expect(finals[b]).toMatchObject({ status: 'done' });
    expect(finals[d]).toMatchObject({ status: 'scheduled', assignee: 'tars:unclaimed' });
    expect((await fetch(`${hermes}/api/plugins/kanban/tasks/${c}`)).status).toBe(404);
  } finally {
    for (const mcp of servers) mcp.kill();
    await app?.close();
    if (bench.pid && bench.exitCode === null) {
      const exited = new Promise(r => bench.once('exit', r));
      bench.kill('SIGTERM');
      await exited;
    }
    for (const f of [ticksFile, launchesFile]) if (fs.existsSync(f)) fs.copyFileSync(f, test.info().outputPath(path.basename(f)));
    await removeHome(home);
  }
});
