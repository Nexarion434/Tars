import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, stepShot, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars cloud M3 (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 10):
 * a project and an agent made on a Tars server from this computer. A
 * headless server started here (cli.js serve, --dev on Windows), the desktop
 * linked to its door by the direct test route (TARS_CLOUD_DIRECT, read only
 * by an unpackaged app), so no SSH is needed.
 *
 * Asserted, in order:
 * 1. + Project, with the server connected, asks where the project lives;
 *    the server chosen, Empty, Create project: the folder is made on the
 *    server (a git folder under its ~/projects) and its card shows on the
 *    Projects page with the server's badge.
 * 2. An agent made in that project through the window's API (the door's
 *    create route), started: it runs the server's fake CLI there, and the
 *    fleet shows its CLI running.
 * 3. An agent made in it through the real New agent window: the server's
 *    project picked in its Project list shows its server's badge; Create and
 *    start makes it on the server, and its task is typed into its CLI once
 *    that CLI runs (the fake CLI records what it is typed).
 * 4. The project's orchestrator, made from the same window with the
 *    Orchestrator switch on: the server makes it with the role, and the task
 *    it hands a worker of the project (run-task with its own token, as
 *    delegate_task does) is typed into that worker's terminal.
 * 5. Delete on a server's agent (2026-11-05): on the Agents page its card's
 *    delete is offered (this computer may create there). The worker at work
 *    (its handed task) is refused, the server's sentence under its card; an
 *    idle agent and the project's orchestrator, confirmed, are deleted there,
 *    their cards go, and the project's folder stays on the server.
 * Leaves values.json and a picture per step in its run directory.
 *   E2E_PORT_OFFSET=40 npx playwright test e2e/cloud-create.spec.ts
 */

const CLI = path.join(process.cwd(), 'electron', 'dist', 'server', 'cli.js');
const SERVER_API = apiPort(31487);
const DESKTOP_API = apiPort(31491);
const PROFILE = 's_e2e0c11e';
const SERVER_NAME = 'e2e-server';
const onWindows = process.platform === 'win32';

/** The server's home: no agent yet, its fake CLI the one a claude agent runs, which writes down what it is typed. */
function serverHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-cloud-create-'));
  const data = path.join(home, '.tars');
  fs.mkdirSync(data, { recursive: true });
  const typed = path.join(home, 'typed.log');
  // Each agent's input also in typed-<its id>.log. "DELEGATE <id> <task>" typed into one makes it hand
  // <task> to agent <id> as the orchestrator's delegate_task does: run-task on the server's API, with
  // the agent's own token from its terminal; the answer goes to typed-<its id>.log.delegated.
  const cli = writeNodeCli(path.join(home, 'ticker.cjs'), [
    "const fs = require('node:fs');",
    `const typed = ${JSON.stringify(typed)};`,
    "const own = typed.slice(0, -4) + '-' + (process.env.CLAUDE_AGENT_ID || 'none') + '.log';",
    'if (process.stdin.isTTY) process.stdin.setRawMode(true);',
    // Its SessionStart, as claude's hook posts it (hooks/session-start.sh), so the server knows it takes keys.
    "if (process.env.CLAUDE_AGENT_ID) void fetch(`${process.env.CLAUDE_MGR_API_URL}/api/hooks/status`, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: require('node:crypto').randomUUID(), status: 'idle', source: 'startup', hook: 'SessionStart', cli_pid: String(process.pid) }),",
    '}).catch(() => {});',
    "let seen = '';",
    'const delegate = (id, task) => fetch(`${process.env.CLAUDE_MGR_API_URL}/api/agents/${id}/run-task`, {',
    "  method: 'POST', body: JSON.stringify({ task, clientRequestId: 'e2e-' + Date.now(), answer: 'started' }),",
    "  headers: { 'Content-Type': 'application/json', 'X-Tars-Client': 'mcp', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': process.env.CLAUDE_AGENT_ID },",
    "}).then(async r => fs.appendFileSync(own + '.delegated', r.status + ' ' + (await r.text()).slice(0, 300) + '\\n'), e => fs.appendFileSync(own + '.delegated', 'error ' + e.message + '\\n'));",
    "process.stdin.on('data', d => {",
    '  fs.appendFileSync(typed, d); fs.appendFileSync(own, d);',
    '  seen += String(d);',
    '  const m = /DELEGATE (\\S+) ([^\\r\\n\\x1b]+)/.exec(seen);',
    "  if (m && /[\\r\\n\\x1b]/.test(seen.slice(m.index + m[0].length))) { seen = ''; void delegate(m[1], m[2].trim()); }",
    '});',
    "let n = 0; process.stdout.write('ticker ready\\r\\n');",
    "setInterval(() => { process.stdout.write('tick ' + (++n) + '\\r\\n'); }, 500);",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(data, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(data, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli },
  }));
  return { home, typed };
}

const serverEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, USERPROFILE: home, DOROTHY_API_PORT: SERVER_API, NODE_ENV: 'production', XDG_STATE_HOME: path.join(home, '.state'),
});

async function startServer(home: string): Promise<{ child: ChildProcess }> {
  let output = '';
  const child = spawn(process.execPath, [CLI, 'serve', ...(onWindows ? ['--dev'] : [])], { cwd: home, env: serverEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', c => { output += String(c); });
  child.stderr!.on('data', c => { output += String(c); });
  const deadline = Date.now() + 120_000;
  while (!['Agent API server running on', '[cloud] door on '].every(m => output.includes(m))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the server did not come up (exit ${child.exitCode}):\n${output.slice(-3000)}`);
    await new Promise(r => setTimeout(r, 250));
  }
  return { child };
}

async function stopServer(server: { child: ChildProcess } | null): Promise<void> {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (onWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
  await Promise.race([exited, new Promise(r => setTimeout(r, 15_000))]);
}

const lastJson = (out: string) => JSON.parse(out.trim().split('\n').pop()!);
const statusOf = (home: string) => lastJson(execFileSync(process.execPath, [CLI, 'status', '--json'], { env: serverEnv(home) }).toString());
// A desktop minted since M3: see, drive and create.
const mint = (home: string) => lastJson(execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], {
  env: serverEnv(home), input: JSON.stringify({ name: 'E2E desktop (desktop)', kind: 'desktop', scopes: ['see', 'drive', 'create'] }),
}).toString());

function desktopHome(minted: { id: string; credential: string; serverId: string }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-cloud-create-desktop-'));
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars-private', 'cloud-link.json'), JSON.stringify({ version: 1, servers: [{
    id: PROFILE, host: 'tars-e2e', runner: { kind: 'command', argv: ['node', 'cli.js'] },
    serverId: minted.serverId, name: SERVER_NAME, clientId: minted.id, credential: minted.credential,
  }] }, null, 2));
  // One folder of this computer's, so the Projects page has a card whose Launch Agent opens New agent.
  const local = path.join(home, 'local-repo');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(path.join(home, '.tars'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([local]));
  return home;
}

type CloudApi = { electronAPI: { cloud: {
  createAgent: (id: string, body: Record<string, unknown>) => Promise<{ success: boolean; agent?: { id: string }; started?: boolean; error?: string; startError?: string }>;
  agents: () => Promise<Array<{ agentId: string; projectPath: string; cliRunning: boolean; role?: string; server: { create?: true } }>>;
} } };

test('a project and an agent made on a tars server from this computer', async () => {
  test.setTimeout(300_000);
  const values: Record<string, unknown> = {};
  const server = serverHome();
  let running: Awaited<ReturnType<typeof startServer>> | null = await startServer(server.home);
  const status = statusOf(server.home);
  const minted = mint(server.home);
  const home = desktopHome(minted);
  const app = await launchSandboxed(electron, home, { env: {
    NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: DESKTOP_API, DOROTHY_E2E: '1', TARS_CLOUD_DIRECT: status.door,
  } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);

    // 1. New project on the server, from the dialog that asks where it lives.
    await expect.poll(async () => page.evaluate(async () => (await (window as unknown as { electronAPI: { cloud: { list: () => Promise<Array<{ state: { phase: string } }>> } } }).electronAPI.cloud.list())[0]?.state.phase), { timeout: 30_000 }).toBe('connected');
    await page.getByRole('button', { name: '+ Project' }).first().click();
    await expect(page.locator(`[data-new-project-place="${PROFILE}"]`)).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Name').fill('made-here');
    await stepShot(page, '01-new-project-on-the-server');
    await page.getByRole('button', { name: 'Create project' }).click();
    const made = path.join(server.home, 'projects', 'made-here');
    const card = page.locator(`[data-cloud-project^="cloud:${status.serverId}:"][data-cloud-project$="made-here"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(`[data-cloud-badge="${SERVER_NAME}"]`)).toBeVisible();
    expect(fs.existsSync(path.join(made, '.git'))).toBe(true);
    values.project = { onServer: made, card: await card.getAttribute('data-cloud-project') };
    await stepShot(page, '02-the-project-on-the-projects-page');

    // 2. An agent in it, made and started through the window's API: the server's fake CLI runs there.
    const projectPath = (await card.getAttribute('data-cloud-project'))!.split(':').slice(2).join(':');
    const created = await page.evaluate(([id, p]) => (window as unknown as CloudApi).electronAPI.cloud.createAgent(id, { projectPath: p, name: 'Made from the desktop', provider: 'claude', start: true }), [PROFILE, projectPath] as const);
    expect(created).toMatchObject({ success: true, started: true });
    values.agent = created;
    const agentOnServer = async () => (await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).find(a => a.agentId === created.agent!.id);
    await expect.poll(async () => (await agentOnServer())?.cliRunning, { timeout: 60_000, message: 'its CLI running on the server' }).toBe(true);
    values.running = await agentOnServer();

    // 3. The real New agent window: the server's project picked, its badge shown, its task typed once its CLI runs.
    await page.getByRole('button', { name: 'open', exact: true }).click();
    await page.getByRole('button', { name: 'Launch Agent', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New agent', exact: true }) });
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await modal.getByLabel('Agent name').fill('Made in the window');
    await modal.getByRole('button', { name: 'Project', exact: true }).click();
    // Listed by its path there (~ only for a /home one, which this test's server home is not), its server beside it.
    const option = page.getByRole('option').filter({ hasText: path.join('projects', 'made-here') }).filter({ hasText: SERVER_NAME });
    await expect(option).toHaveCount(1);
    await option.click();
    await expect(modal.getByRole('button', { name: 'Project', exact: true }).locator(`[data-cloud-badge="${SERVER_NAME}"]`)).toBeVisible();
    const task = 'say hello from the window';
    await modal.getByPlaceholder('Describe what you want done.').fill(task);
    await stepShot(page, '03-new-agent-in-the-server-project');
    const before = new Set((await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).map(a => a.agentId));
    await modal.getByRole('button', { name: 'Create and start', exact: true }).click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    const madeInWindow = async () => (await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).find(a => !before.has(a.agentId));
    await expect.poll(async () => (await madeInWindow())?.cliRunning, { timeout: 60_000, message: 'the window\'s agent running on the server' }).toBe(true);
    await expect.poll(() => fs.existsSync(server.typed) ? fs.readFileSync(server.typed, 'utf8') : '', { timeout: 60_000, message: 'its task typed into its CLI' }).toContain(task);
    values.window = { agent: await madeInWindow(), typed: fs.readFileSync(server.typed, 'utf8') };
    await stepShot(page, '04-its-task-sent');

    // 4. The project's orchestrator on the server, from the same window ("l'orchestrateur en cloud"):
    //    the Orchestrator switch on for a server's project, made there with the role, and it hands a
    //    task to a worker of that project, which gets it typed into its terminal.
    const worker = created.agent!.id;
    await page.getByRole('button', { name: 'Launch Agent', exact: true }).click();
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await modal.getByLabel('Agent name').fill('Lead');
    await modal.getByRole('button', { name: 'Project', exact: true }).click();
    await option.click();
    await modal.getByRole('button', { name: 'Options' }).click();
    await modal.getByText('Orchestrator', { exact: true }).locator('xpath=../..').getByRole('switch').click();
    await modal.getByPlaceholder('Describe what you want done.').fill(`DELEGATE ${worker} hand-off from the lead`);
    await stepShot(page, '05-an-orchestrator-on-the-server');
    const known = new Set((await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).map(a => a.agentId));
    await modal.getByRole('button', { name: 'Create and start', exact: true }).click();
    await expect(modal).toHaveCount(0, { timeout: 30_000 });
    const lead = async () => (await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).find(a => !known.has(a.agentId));
    await expect.poll(async () => (await lead())?.role, { timeout: 60_000, message: 'made as its project\'s orchestrator' }).toBe('orchestrator');
    const workerTyped = path.join(server.home, `typed-${worker}.log`);
    await expect.poll(() => fs.existsSync(workerTyped) ? fs.readFileSync(workerTyped, 'utf8') : '', { timeout: 90_000, message: 'the task the lead handed typed into the worker' }).toContain('hand-off from the lead');
    const leadId = (await lead())!.agentId;
    values.orchestrator = { agent: await lead(), delegated: fs.readFileSync(path.join(server.home, `typed-${leadId}.log.delegated`), 'utf8') };
    await stepShot(page, '06-the-worker-got-its-task');

    // 5. Delete on a server's agent, from its card on the Agents page: offered, confirmed, gone there and here.
    const doomed = await page.evaluate(([id, p]) => (window as unknown as CloudApi).electronAPI.cloud.createAgent(id, { projectPath: p, name: 'To delete', provider: 'claude' }), [PROFILE, projectPath] as const);
    expect(doomed).toMatchObject({ success: true, started: false });
    const doomedId = `c:${status.serverId}:${doomed.agent!.id}`;
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    const doomedCard = page.locator(`[data-agent-card="${doomedId}"]`);
    await expect(doomedCard).toBeVisible({ timeout: 30_000 });
    const deleteButton = doomedCard.getByRole('button', { name: 'delete', exact: true });
    await expect(deleteButton).toBeEnabled();
    await stepShot(page, '07-delete-offered-on-the-server-agent');
    const confirmDelete = async (card: typeof doomedCard): Promise<string> => {
      const confirmed = new Promise<string>(resolve => page.once('dialog', dialog => { resolve(dialog.message()); void dialog.accept(); }));
      await card.getByRole('button', { name: 'delete', exact: true }).click();
      return confirmed;
    };
    // The worker is at work on the task the lead handed it: the server leaves it, and says why under its card.
    const busyCard = page.locator(`[data-agent-card="c:${status.serverId}:${worker}"]`);
    values.refusedConfirm = await confirmDelete(busyCard);
    await expect(busyCard.locator('[data-cloud-drive-error]')).toHaveText(/^Made from the desktop is at work on .+: stop it first, then delete it\.$/, { timeout: 30_000 });
    await expect(busyCard).toBeVisible();
    await stepShot(page, '08-an-agent-at-work-refused');
    values.deleteConfirm = await confirmDelete(doomedCard);
    expect(values.deleteConfirm).toContain(`on ${SERVER_NAME}`);
    await expect(doomedCard).toHaveCount(0, { timeout: 30_000 });
    // The project's orchestrator, removed like any other agent.
    const leadCard = page.locator(`[data-agent-card="c:${status.serverId}:${leadId}"]`);
    await confirmDelete(leadCard);
    await expect(leadCard).toHaveCount(0, { timeout: 30_000 });
    const left = await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents());
    expect(left.map(a => a.agentId)).not.toContain(doomed.agent!.id);
    expect(left.map(a => a.agentId)).not.toContain(leadId);
    expect(left.map(a => a.agentId)).toContain(worker);
    expect(left.every(a => a.server.create === true)).toBe(true);
    expect(fs.existsSync(path.join(made, '.git'))).toBe(true);
    values.deleted = { agents: [doomed.agent, leadId], leftOnServer: left.map(a => a.agentId), folderKept: made };
    await stepShot(page, '09-their-cards-gone');
    recordValues(values);
  } finally {
    await app.close();
    await stopServer(running);
    running = null;
    // E2E_KEEP_HOMES=1 keeps both homes to read what the server and its fake CLIs wrote.
    if (process.env.E2E_KEEP_HOMES === '1') console.log(`[e2e] kept: ${home} ${server.home}`);
    else for (const dir of [home, server.home]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
