import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, stepShot, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Tars server's agent on the desktop (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 14).
 * A headless server (node electron/dist/server/cli.js serve) in a home of its
 * own runs an agent whose stand-in CLI prints a numbered tick every half
 * second and records what is typed into it. A sandboxed desktop holds a
 * credential minted on that server (`clients add`, as a connect over SSH
 * mints it) and reaches the server's door by the direct test route
 * (TARS_CLOUD_DIRECT, read only by an unpackaged app), so no SSH is needed.
 *
 * Asserted, in order:
 * 1. The server's agent is on the Dashboard, its server's name as its badge.
 * 2. Started from its pane's start, its pane shows the server's terminal live:
 *    a later tick appears.
 * 3. What is typed in the pane reaches the server's CLI as typed.
 * 4. Stop asks why, and the server files the reason.
 * 5. The server process goes away: the pane says the server is offline since
 *    when, and its last output stays.
 * 6. The server is back: the offline line goes, and the agent started again
 *    is live in the same pane.
 * 7. Settings > Cloud says where the server is, how it runs, and its link.
 * Leaves values.json and a picture per step in its run directory.
 *   E2E_PORT_OFFSET=40 npx playwright test e2e/cloud-see-drive.spec.ts
 */

const CLI = path.join(process.cwd(), 'electron', 'dist', 'server', 'cli.js');
const SERVER_API = apiPort(31489);
const DESKTOP_API = apiPort(31493);
const PROFILE = 's_e2e0c10d';
const SERVER_NAME = 'e2e-server';
const AGENT = { id: 'cloud-ticker', name: 'Ticker on the server' };
const onWindows = process.platform === 'win32';

/** The server's home: its agent, a ticker that records what is typed into it, idle until started. */
function serverHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-cloud-server-'));
  const project = path.join(home, 'projects', 'demo');
  const data = path.join(home, '.tars');
  for (const dir of [project, data]) fs.mkdirSync(dir, { recursive: true });
  const typed = path.join(home, 'typed.txt');
  const cli = writeNodeCli(path.join(home, 'ticker.cjs'), [
    'if (process.stdin.isTTY) process.stdin.setRawMode(true);',
    `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(typed)}, d));`,
    "let n = 0; process.stdout.write('ticker ready\\r\\n');",
    "setInterval(() => { process.stdout.write('tick ' + (++n) + '\\r\\n'); }, 500);",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project,
    skills: [], permissionMode: 'bypass', cliPath: cli, createdAt: '2026-11-03T08:00:00.000Z', lastActivity: '2026-11-03T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(data, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(data, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: cli },
  }));
  return { home, typed };
}

const serverEnv = (home: string): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, USERPROFILE: home, DOROTHY_API_PORT: SERVER_API, NODE_ENV: 'production', XDG_STATE_HOME: path.join(home, '.state'),
});

/** The server in the foreground, once its API and its door are up. Windows serves only with --dev. */
async function startServer(home: string): Promise<{ child: ChildProcess; output: () => string }> {
  let output = '';
  const child = spawn(process.execPath, [CLI, 'serve', ...(onWindows ? ['--dev'] : [])], { cwd: home, env: serverEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', c => { output += String(c); });
  child.stderr!.on('data', c => { output += String(c); });
  const deadline = Date.now() + 120_000;
  while (!['Agent API server running on', '[cloud] door on '].every(m => output.includes(m))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the server did not come up (exit ${child.exitCode}):\n${output.slice(-3000)}`);
    await new Promise(r => setTimeout(r, 250));
  }
  return { child, output: () => output };
}

/** Ends the server and what it started (its agent's terminal included). */
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
const mint = (home: string) => lastJson(execFileSync(process.execPath, [CLI, 'clients', 'add', '--json'], {
  env: serverEnv(home), input: JSON.stringify({ name: 'E2E desktop (desktop)', kind: 'desktop', scopes: ['see', 'drive'] }),
}).toString());

/** The desktop's home: the server in Settings > Cloud as a first connect leaves it, credential and all. */
function desktopHome(minted: { id: string; credential: string; serverId: string }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-cloud-desktop-'));
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars-private', 'cloud-link.json'), JSON.stringify({ version: 1, servers: [{
    id: PROFILE, host: 'tars-e2e', runner: { kind: 'command', argv: ['node', 'cli.js'] },
    serverId: minted.serverId, name: SERVER_NAME, clientId: minted.id, credential: minted.credential,
  }] }, null, 2));
  return home;
}

/** The terminal of the pane whose panel names `name`, as e2e/panel-history.spec.ts finds it. */
async function terminalOf(page: Page, name: string): Promise<Locator> {
  const indexOf = () => page.locator('.xterm').evaluateAll((terminals, wanted) => terminals.findIndex(terminal => {
    let panel = terminal.parentElement;
    while (panel && !panel.querySelector('button[aria-label="Panel actions"]')) panel = panel.parentElement;
    return !!panel && (panel.textContent ?? '').includes(wanted);
  }), name);
  await expect.poll(indexOf, { timeout: 60_000, message: `the pane of ${name}` }).toBeGreaterThanOrEqual(0);
  return page.locator('.xterm').nth(await indexOf());
}

const ticksIn = (text: string) => [...text.matchAll(/tick (\d+)/g)].map(m => Number(m[1]));
type CloudApi = { electronAPI: { cloud: { agents: () => Promise<Array<{ agentId: string; stopReason?: string; stoppedBy?: string; cliRunning: boolean }>> } } };

test("a tars server's agent on the dashboard: live, typed into, stopped with a reason, offline and back", async () => {
  test.setTimeout(420_000);
  const values: Record<string, unknown> = {};
  const server = serverHome();
  let running: Awaited<ReturnType<typeof startServer>> | null = await startServer(server.home);
  const status = statusOf(server.home);
  const minted = mint(server.home);
  expect(minted.serverId).toBe(status.serverId);
  const home = desktopHome(minted);
  values.serverId = status.serverId;
  const app = await launchSandboxed(electron, home, { env: {
    NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: DESKTOP_API, DOROTHY_E2E: '1', TARS_CLOUD_DIRECT: status.door,
  } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);

    // 1. The server's agent, badged with the server's name.
    const terminal = await terminalOf(page, AGENT.name);
    await expect(page.locator(`[data-cloud-badge="${SERVER_NAME}"]`).first()).toBeVisible({ timeout: 30_000 });
    values.badge = SERVER_NAME;
    await stepShot(page, '01-the-server-agent-on-the-dashboard');

    // 2. Started from its pane, then live.
    await page.getByTitle('Start claude in this terminal').first().click();
    const rows = terminal.locator('.xterm-rows');
    // A numbered tick: "ticker ready" holds the word too.
    await expect(rows).toContainText(/tick \d+/, { timeout: 60_000 });
    const first = Math.max(...ticksIn(await rows.innerText()));
    expect(first).toBeGreaterThan(0);
    await expect.poll(async () => Math.max(...ticksIn(await rows.innerText())), { timeout: 15_000 }).toBeGreaterThan(first + 2);
    values.firstTick = first;
    values.laterTick = Math.max(...ticksIn(await rows.innerText()));
    await stepShot(page, '02-the-server-agent-live');

    // 3. Typed in the pane, as typed in the server's CLI.
    await terminal.locator('.xterm-screen').click();
    await page.keyboard.type('hello from the desktop');
    await page.keyboard.press('Enter');
    const readTyped = () => (fs.existsSync(server.typed) ? fs.readFileSync(server.typed, 'utf8') : '');
    await expect.poll(readTyped, { timeout: 15_000 }).toContain('hello from the desktop\r');
    values.typedOnTheServer = JSON.stringify(readTyped());

    // 4. Stop asks why, and the server files the reason.
    await page.getByTitle('Stop this agent').first().click();
    const reason = page.locator('[data-cloud-stop-reason]');
    await expect(reason).toBeVisible();
    await reason.fill('the e2e is done with it');
    await reason.press('Enter');
    const agentOnServer = async () => (await page.evaluate(() => (window as unknown as CloudApi).electronAPI.cloud.agents())).find(a => a.agentId === AGENT.id);
    await expect.poll(async () => (await agentOnServer())?.stopReason, { timeout: 20_000 }).toBe('the e2e is done with it');
    values.stopped = await agentOnServer();
    await stepShot(page, '03-stopped-with-a-reason');

    // 5. The server goes away: since when, and the last output stays.
    const lastSeen = Math.max(...ticksIn(await rows.innerText()));
    await stopServer(running);
    running = null;
    const offline = page.locator('[data-cloud-offline]');
    await expect(offline).toBeVisible({ timeout: 30_000 });
    await expect(offline).toHaveText(new RegExp(`^${SERVER_NAME} offline since \\d{2}:\\d{2}\\. Its last output stays below`));
    expect(ticksIn(await rows.innerText())).toContain(lastSeen);
    values.offlineLine = await offline.textContent();
    await stepShot(page, '04-the-server-offline');

    // 6. Back: the pane is live again.
    running = await startServer(server.home);
    await expect(offline).toHaveCount(0, { timeout: 30_000 });
    values.backOnline = true;
    // Live again: the agent started anew, its ticks run on in the same pane
    // (the pane takes the server's fresh screen first, which may replace the old one).
    const lastTick = async () => ticksIn(await rows.innerText()).at(-1) ?? -1;
    const stale = await lastTick();
    await page.getByTitle('Start claude in this terminal').first().click({ timeout: 30_000 });
    await expect.poll(async () => (await agentOnServer())?.cliRunning, { timeout: 30_000, message: 'the server runs its agent again' }).toBe(true);
    await expect.poll(async () => { const now = await lastTick(); return now !== stale ? now : -1; }, { timeout: 30_000, message: 'a new tick in the same pane' }).toBeGreaterThan(0);
    const resumed = await lastTick();
    await expect.poll(lastTick, { timeout: 15_000, message: 'and more after it' }).toBeGreaterThan(resumed);
    values.liveAgainAfterRestart = { resumedAt: resumed, then: await lastTick() };
    await stepShot(page, '05b-live-again');
    await stepShot(page, '05-the-server-back');

    // 7. Settings > Cloud: the server, how it runs and its link in words.
    await page.goto(`${DEV_URL}/settings?section=cloud`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    const line = page.locator('[data-cloud-server-line]');
    await expect(line).toHaveText(/^tars-e2e · installed · connected since \d{2}:\d{2}$/, { timeout: 15_000 });
    values.settingsLine = await line.textContent();
    // The frame `Settings · Cloud · connected`: Disconnect and Forget on the card, Advanced closed below.
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Forget this server' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('Door path')).toHaveCount(0);
    await stepShot(page, '06-settings-cloud');
    recordValues(values);
  } finally {
    await app.close();
    await stopServer(running);
    for (const dir of [home, server.home]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
