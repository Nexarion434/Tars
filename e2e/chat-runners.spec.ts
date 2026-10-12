import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each chat runs its own conversation with the orchestrator (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2 and 4.3, PR D),
 * in the real app, through the window's channels and the agents' API.
 *
 * A sandbox HOME with one project, a git repository whose origin's main is one commit and whose root has another
 * branch checked out; the orchestrator "Lead" (model opus-test) and a worker. The CLIs are stand-ins named
 * `claude`: they run Tars's own hook scripts with the JSON Claude Code gives them, keep a transcript where Claude
 * Code keeps it, continue the session `--resume` names, record every launch's argv and folder, and hold a turn whose
 * prompt says HOLD until told to end it. The RAM figure is the E2E's: 10 GB, so two chats work at once.
 *
 * Asserted, in order:
 * 1. a send in Main starts the orchestrator, with its model, its instructions and its tool block;
 * 2. a first send in chat A makes its runner: "Lead · Release", a worker of kind chat, in .worktrees/chat-<id> on
 *    chat/<id>, started from origin/main and not from the root's branch, launched like the orchestrator (model,
 *    instructions, --disallowed-tools), in its worktree;
 * 3. with both slots taken, a send in chat B puts A, idle, to sleep and starts B: two runners, two sessions, two
 *    worktrees;
 * 4. the next send in A puts B to sleep and resumes A's session (--resume <its id>);
 * 5. with Main and A both in a turn, a send in B answers chat_limit, with its sentence and who works;
 * 6. two sends in one tick for one free slot: one runner starts, the other answers chat_limit;
 * 7. a worker's reply to "requester" reaches the chat that asked; one to the orchestrator's id reaches it (R5);
 * 8. chat B's runner cannot cancel chat C's queued task (not_your_task); Main's orchestrator cannot without a
 *    reason, and can with one, and chat C is told (R6);
 * 9. under 2 GB free, a first send answers with the reason and makes no worktree (R7);
 * 10. scripts/worktree.mjs status lists the runners' worktrees;
 * 11. deleting chat B removes its runner and its worktree, its branch kept.
 * The artefact: values.json (each answer, the launches, the worktrees), launches.jsonl and prompts.jsonl.
 */

const HOOKS = path.resolve('hooks');
const WORKTREE_TOOL = path.resolve('scripts', 'worktree.mjs');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
// As Claude Code: --resume <id> continues that session, in its own transcript.
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, resume: resumed === -1 ? null : args[resumed + 1], prompt: launchPrompt, argv: args, cwd: process.cwd() });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  // A turn told to hold runs until the test lets it end.
  if (prompt.includes('HOLD>>')) {
    const release = path.join(process.env.HOME, 'release-' + id);
    while (!fs.existsSync(release)) await sleep(100);
    fs.rmSync(release, { force: true });
  }
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else if (ch === '\x7f') buffer = buffer.slice(0, -1);
      else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

type Agent = {
  id: string; name?: string; role?: string; kind?: string; chatId?: string; status: string; cliRunning?: boolean;
  worktreePath?: string; branchName?: string; projectPath: string; taskQueue?: Array<{ ref: string; requesterAgentId: string; state: string }>;
};
type ChatRecord = { id: string; number: number; title: string; runnerId: string | null; inbox: boolean; settledAt: string | null };
type Answer = Record<string, unknown>;
type Launch = { id: string; sid: string; resume: string | null; prompt: string; argv: string[]; cwd: string };

const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test("chats: each runs its own conversation, within the RAM's limit, and owns its work", async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-runners-'));
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });

  // origin's main, and the root on another branch: a runner starts from the first, never from the second.
  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
  const gitSeed = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  gitSeed(home, 'init', '-q', '--bare', origin);
  gitSeed(home, 'init', '-q', '-b', 'main', project);
  fs.writeFileSync(path.join(project, 'README.md'), 'on main\n');
  gitSeed(project, 'add', '.');
  gitSeed(project, 'commit', '-q', '-m', 'main');
  gitSeed(project, 'remote', 'add', 'origin', origin);
  gitSeed(project, 'push', '-q', '-u', 'origin', 'main');
  gitSeed(project, 'checkout', '-q', '-b', 'feature-x');
  fs.writeFileSync(path.join(project, 'feature.txt'), 'only on feature-x\n');
  gitSeed(project, 'add', '.');
  gitSeed(project, 'commit', '-q', '-m', 'feature');
  const originMain = git(project, 'rev-parse', 'origin/main');
  const rootHead = git(project, 'rev-parse', 'HEAD');

  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Lead', 'orchestrator', { model: 'opus-test' }), agent('w1', 'Worker', 'worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const promptsFile = path.join(home, 'prompts.jsonl');
  const port = apiPort(31455);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, project, originMain, rootHead };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '10' },
  });
  try {
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    const call = (ns: string, name: string, arg?: unknown) => page.evaluate(([ns, name, arg]) => {
      const api = (window as unknown as { electronAPI: Record<string, Record<string, (a?: unknown) => Promise<Answer>>> }).electronAPI;
      return api[ns as string][name as string](arg);
    }, [ns, name, arg] as const);
    const chats = async () => (await call('chat', 'list') as unknown as { chats: ChatRecord[] }).chats;
    const send = (chatId: string, text: string) => call('chat', 'send', { chatId, text, clientRequestId: `e2e-${Math.random()}` });
    const fleet = async () => await page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Agent[]> } } }).electronAPI.agent.list());
    const agentOf = async (id: string) => (await fleet()).find((a) => a.id === id);
    const runnerOf = async (chatId: string) => (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chatId);
    const launchesOf = (id: string) => lines<Launch>(launchesFile).filter((l) => l.id === id);
    const promptsOf = (id: string) => lines<{ id: string; prompt: string }>(promptsFile).filter((l) => l.id === id).map((l) => l.prompt);
    const atRest = (id: string) => expect.poll(async () => (await agentOf(id))?.status, { timeout: 30_000 }).toMatch(/^(idle|completed)$/);
    const release = (id: string) => fs.writeFileSync(path.join(home, `release-${id}`), '');
    // Each in one spelling: git may print a temporary folder as /var/... or /private/var/....
    const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.join(fs.realpathSync(path.dirname(p)), path.basename(p)));
    const worktrees = () => git(project, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)));

    // 1. Main: the orchestrator, started by the first send, as the orchestrator.
    const main = (await chats()).find((c) => c.number === 1)!;
    const toMain = await send(main.id, 'MAIN>> hello');
    keep({ toMain });
    expect(toMain).toMatchObject({ success: true, runnerId: 'o1', how: 'launched' });
    await expect.poll(() => promptsOf('o1'), { timeout: 30_000 }).toContain('MAIN>> hello');
    await atRest('o1');
    const leadArgv = launchesOf('o1')[0].argv;
    expect(leadArgv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--append-system-prompt-file', '--disallowed-tools']));

    // 2. Chat A's runner, made by its first send.
    const chatA = await call('chat', 'create', { projectPath: project, title: 'Release' }) as unknown as ChatRecord;
    const chatB = await call('chat', 'create', { projectPath: project, title: 'Bug' }) as unknown as ChatRecord;
    const toA = await send(chatA.id, 'A>> first');
    keep({ toA });
    expect(toA).toMatchObject({ success: true, how: 'launched' });
    const runnerA = (await runnerOf(chatA.id))!;
    keep({ runnerA });
    expect(runnerA).toMatchObject({ name: 'Lead · Release', role: 'worker', kind: 'chat', chatId: chatA.id, projectPath: project });
    expect(runnerA.worktreePath).toMatch(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.worktrees/chat-[0-9a-f]{8}$`));
    expect(runnerA.branchName).toBe(`chat/${path.basename(runnerA.worktreePath!).slice(5)}`);
    expect(worktrees()).toContain(real(runnerA.worktreePath!));
    expect(git(runnerA.worktreePath!, 'rev-parse', 'HEAD')).toBe(originMain);
    expect(originMain).not.toBe(rootHead);
    await expect.poll(() => promptsOf(runnerA.id), { timeout: 30_000 }).toContain('A>> first');
    await atRest(runnerA.id);
    const launchA = launchesOf(runnerA.id)[0];
    expect(launchA.argv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--append-system-prompt-file', '--disallowed-tools']));
    expect(fs.realpathSync(launchA.cwd)).toBe(fs.realpathSync(runnerA.worktreePath!));
    expect(await call('system', 'chatLimit')).toMatchObject({ limit: 2, working: 2 });

    // 3. Both slots taken: B's first send puts A, idle, to sleep.
    const toB = await send(chatB.id, 'B>> first');
    keep({ toB });
    expect(toB).toMatchObject({ success: true, how: 'launched' });
    const runnerB = (await runnerOf(chatB.id))!;
    await expect.poll(async () => (await agentOf(runnerA.id))?.status, { timeout: 15_000 }).toBe('asleep');
    await expect.poll(() => promptsOf(runnerB.id), { timeout: 30_000 }).toContain('B>> first');
    await atRest(runnerB.id);
    const launchB = launchesOf(runnerB.id)[0];
    expect(launchB.argv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--disallowed-tools']));
    expect(launchB.sid).not.toBe(launchA.sid);
    expect(worktrees()).toEqual(expect.arrayContaining([real(runnerA.worktreePath!), real(runnerB.worktreePath!)]));

    // 4. A again: B sleeps, A resumes its own session.
    const toA2 = await send(chatA.id, 'A>> second');
    keep({ toA2 });
    expect(toA2).toMatchObject({ success: true, how: 'launched' });
    await expect.poll(async () => (await agentOf(runnerB.id))?.status, { timeout: 15_000 }).toBe('asleep');
    await expect.poll(() => launchesOf(runnerA.id).length, { timeout: 30_000 }).toBe(2);
    expect(launchesOf(runnerA.id)[1].resume).toBe(launchA.sid);
    await expect.poll(() => promptsOf(runnerA.id), { timeout: 30_000 }).toContain('A>> second');
    await atRest(runnerA.id);

    // 5. Main and A both in a turn: a send in B answers chat_limit, and says who works.
    expect(await send(chatA.id, 'HOLD>> a')).toMatchObject({ success: true, how: 'typed' });
    expect(await send(main.id, 'HOLD>> m')).toMatchObject({ success: true, how: 'typed' });
    await expect.poll(async () => [(await agentOf(runnerA.id))?.status, (await agentOf('o1'))?.status], { timeout: 30_000 }).toEqual(['running', 'running']);
    const limited = await send(chatB.id, 'B>> second');
    keep({ limited });
    expect(limited).toMatchObject({ error: 'chat_limit', limit: 2, ramGb: 10 });
    expect(String(limited.reason)).toContain('2 chats are already working, the most this Mac runs at once (10 GB of RAM, one chat per 5 GB)');
    expect((limited.working as Array<{ title: string }>).map((w) => w.title).sort()).toEqual(['Main', 'Release']);
    release(runnerA.id);
    release('o1');
    await atRest(runnerA.id);
    await atRest('o1');

    // 6. One free slot, two sends in one tick: one starts, the other answers chat_limit.
    const settled = await call('chat', 'settle', { chatId: chatA.id, settled: true });
    keep({ settled });
    await expect.poll(async () => (await agentOf(runnerA.id))?.status, { timeout: 15_000 }).toBe('asleep');
    const chatC = await call('chat', 'create', { projectPath: project, title: 'Docs' }) as unknown as ChatRecord;
    const chatD = await call('chat', 'create', { projectPath: project, title: 'Design' }) as unknown as ChatRecord;
    const both = await Promise.all([send(chatC.id, 'C>> one'), send(chatD.id, 'D>> one')]);
    keep({ both });
    expect(both.filter((a) => a.how === 'launched')).toHaveLength(1);
    expect(both.filter((a) => a.error === 'chat_limit')).toHaveLength(1);
    const startedChat = both[0].how === 'launched' ? chatC : chatD;
    const runnerC = (await runnerOf(startedChat.id))!;
    await atRest(runnerC.id);

    // Tokens, as each agent's hooks and MCP servers have them.
    const tokens = await app.evaluate((_e, { dist, ids }) => {
      const req = process.mainModule!.require;
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
      return out;
    }, { dist, ids: ['o1', 'w1', runnerB.id, runnerC.id] });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Answer }));

    // 7. R5: the worker answers whoever asked for its current task, unless it names an id.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'w1', prompt: '' }));
    await expect.poll(async () => (await agentOf('w1'))?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    await atRest('w1');
    const asked = await api('/api/agents/w1/message', runnerC.id, { message: 'R5>> report to me' });
    await expect.poll(() => promptsOf('w1').some((p) => p.includes('R5>> report to me')), { timeout: 30_000 }).toBe(true);
    const toRequester = await api('/api/agents/requester/message', 'w1', { message: 'REPLY>> for my asker' });
    const toLeadById = await api('/api/agents/o1/message', 'w1', { message: 'ID>> for the lead' });
    keep({ asked, toRequester, toLeadById });
    expect(toRequester.status).toBe(200);
    expect(toRequester.body).toMatchObject({ deliveredTo: { id: runnerC.id, how: 'requester' } });
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('REPLY>> for my asker')), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => promptsOf('o1').some((p) => p.includes('ID>> for the lead')), { timeout: 30_000 }).toBe(true);
    expect(promptsOf(runnerC.id).some((p) => p.includes('ID>> for the lead'))).toBe(false);
    await atRest('w1');
    await atRest(runnerC.id);
    await atRest('o1');

    // 8. Ownership (R6): a request held behind a draft in the worker's field is queued.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'w1', input: 'x' }));
    const held = await api('/api/agents/w1/message', runnerC.id, { message: 'QUEUED>> later' });
    expect(held.body).toMatchObject({ held: true });
    const queued = (await agentOf('w1'))!.taskQueue!.find((r) => r.requesterAgentId === runnerC.id && r.state === 'queued')!;
    const byOtherChat = await api(`/api/tasks/${queued.ref}/cancel`, runnerB.id, {});
    const byLeadNoReason = await api(`/api/tasks/${queued.ref}/cancel`, 'o1', {});
    const byLead = await api(`/api/tasks/${queued.ref}/cancel`, 'o1', { reason: 'the docs moved to Main' });
    keep({ queued, byOtherChat, byLeadNoReason, byLead });
    expect(byOtherChat).toMatchObject({ status: 403, body: { error: 'not_your_task' } });
    expect(byLeadNoReason).toMatchObject({ status: 400, body: { error: 'reason_required' } });
    expect(byLead).toMatchObject({ status: 200, body: { success: true, cancelled: queued.ref } });
    expect((await agentOf('w1'))!.taskQueue?.some((r) => r.ref === queued.ref) ?? false).toBe(false);
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('cancelled') && p.includes('the docs moved to Main')), { timeout: 30_000 }).toBe(true);
    // The draft goes, and nothing of the cancelled message is typed after it.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'w1', input: '\x7f' }));
    await page.waitForTimeout(1_500);
    expect(promptsOf('w1').some((p) => p.includes('QUEUED>> later'))).toBe(false);

    // 9. R7: under the 2 GB floor, a first send makes no worktree, and says why.
    await app.evaluate((_e, { dist }) => { process.mainModule!.require(`${dist}/core/disk-space.js`).setFreeSpaceReader(() => 1024 ** 3); }, { dist });
    const chatE = await call('chat', 'create', { projectPath: project, title: 'Floor' }) as unknown as ChatRecord;
    const before = worktrees();
    const floored = await send(chatE.id, 'E>> one');
    await app.evaluate((_e, { dist }) => { process.mainModule!.require(`${dist}/core/disk-space.js`).setFreeSpaceReader(undefined); }, { dist });
    keep({ floored });
    expect(floored).toMatchObject({ error: 'disk_full' });
    expect(String(floored.reason)).toContain('free');
    expect(worktrees()).toEqual(before);
    expect(await runnerOf(chatE.id)).toBeUndefined();

    // 10. The worktree tool sees the runners' worktrees.
    const status = execFileSync(process.execPath, [WORKTREE_TOOL, 'status'], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    keep({ status });
    for (const r of [runnerA, runnerB, runnerC]) expect(status).toContain(path.basename(r.worktreePath!));

    // 11. Deleting chat B: its runner and its worktree go, its branch stays.
    const deleted = await call('chat', 'delete', { chatId: chatB.id });
    keep({ deleted, worktreesAtEnd: worktrees(), launches: lines(launchesFile) });
    expect(deleted).toMatchObject({ success: true });
    expect(await agentOf(runnerB.id)).toBeUndefined();
    expect(worktrees()).not.toContain(real(runnerB.worktreePath!));
    expect(git(project, 'branch', '--list', runnerB.branchName!)).toContain(runnerB.branchName!);
  } finally {
    for (const id of ['o1']) fs.writeFileSync(path.join(home, `release-${id}`), '');
    await app.close();
    fs.copyFileSync(launchesFile, test.info().outputPath('launches.jsonl'));
    if (fs.existsSync(promptsFile)) fs.copyFileSync(promptsFile, test.info().outputPath('prompts.jsonl'));
  }
});
