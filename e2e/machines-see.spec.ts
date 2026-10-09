import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, stepShot, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Seeing another machine's agents (multi-machine, part 2). Two Tars, two
 * homes, two bridges on 127.0.0.1 (TARS_MACHINES_BIND / _PORT stand where the
 * tailnet would), paired before they start: machines.json written in each
 * home as a pairing writes it. B runs an agent whose stand-in CLI prints a
 * numbered tick every half second and records what is typed into it.
 *
 * Asserted, in order:
 * 1. A's Dashboard shows B's agent, under B's name as its badge.
 * 2. Its pane shows B's terminal and goes on with it: a later tick appears;
 *    and at B's terminal's size, as many rows with the status bar B's CLI
 *    draws on its last one, scaled to stay within the panel.
 * 3. Read only: what is typed into A's pane never reaches B's CLI.
 * 4. B quits: within twenty seconds A's pane says B is offline since when,
 *    and its last output stays.
 *
 * Driving it (part 3), where B lets A drive:
 * 5. What is typed in A's pane reaches B's CLI as typed, Enter and Esc
 *    included, with no bar to type it in (Nicolas, 2026-10-09).
 * 5b. B's terminal takes the size of A's pane, which it fills unscaled, and
 *    B's CLI draws at it; 5c. in fullscreen too, and back; 5d. a click in
 *    B's own pane takes the size back (Nicolas, 2026-10-09).
 * 6. A's stop needs a reason, and B files it: stopped by "Mac (machine)",
 *    with that reason.
 * 7. A's start runs B's agent again: its CLI runs.
 * 8. B takes Drive back: A's pane says it may only see, and an action asked
 *    anyway comes back refused with B's sentence.
 * Leaves a run directory with each step's picture and the values asserted.
 *   E2E_PORT_OFFSET=70 npx playwright test e2e/machines-see.spec.ts
 */
const A = { api: apiPort(31485), bridge: apiPort(31495) };
const B = { api: apiPort(31487), bridge: apiPort(31497) };
const AGENT = { id: 'remote-ticker', name: 'Ticker on the PC' };

const secret = () => crypto.randomBytes(32).toString('base64url');
const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Both homes' machines.json, as pairing writes them: each holds the hash of the secret it issued, and the secret it was issued. */
function pairHomes(aHome: string, bHome: string, bLetsA: 'see' | 'drive' = 'see') {
  const ids = { a: `m-${crypto.randomBytes(8).toString('hex')}`, b: `m-${crypto.randomBytes(8).toString('hex')}` };
  const aIssued = secret();
  const bIssued = secret();
  const at = new Date().toISOString();
  const write = (home: string, file: unknown) => {
    fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tars-private', 'machines.json'), JSON.stringify(file, null, 2));
  };
  write(aHome, { version: 1, self: { id: ids.a, name: 'Mac' }, peers: [{ id: ids.b, name: 'PC', address: '127.0.0.1', port: Number(B.bridge), inboundSecretHash: hash(aIssued), outboundSecret: bIssued, mayOnMe: 'see', pairedAt: at }] });
  write(bHome, { version: 1, self: { id: ids.b, name: 'PC' }, peers: [{ id: ids.a, name: 'Mac', address: '127.0.0.1', port: Number(A.bridge), inboundSecretHash: hash(bIssued), outboundSecret: aIssued, mayOnMe: bLetsA, pairedAt: at }] });
}

/** B's pairing file, with what it lets A do now: read again at A's next request. */
function letA(bHome: string, mayOnMe: 'see' | 'drive') {
  const file = path.join(bHome, '.tars-private', 'machines.json');
  const machines = JSON.parse(fs.readFileSync(file, 'utf8'));
  machines.peers = machines.peers.map((p: Record<string, unknown>) => ({ ...p, mayOnMe }));
  fs.writeFileSync(file, JSON.stringify(machines, null, 2));
}

/** Two homes paired, and B's agent: a ticker whose CLI records what is typed into it. */
function twoHomes(name: string, bLetsA: 'see' | 'drive') {
  const aHome = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-${name}-a-`));
  const bHome = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-${name}-b-`));
  pairHomes(aHome, bHome, bLetsA);
  // B's agent, idle until started, in a project A does not have.
  const project = path.join(bHome, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const received = path.join(bHome, 'typed.txt');
  const cli = writeNodeCli(path.join(bHome, 'ticker.cjs'), [
    'if (process.stdin.isTTY) process.stdin.setRawMode(true);',
    `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(received)}, d));`,
    // A status bar on its terminal's last row, as Claude Code draws one: placed by the size it runs in.
    "const bar = () => process.stdout.write('\\x1b7\\x1b[' + process.stdout.rows + ';1Hstatus bar ' + process.stdout.columns + 'x' + process.stdout.rows + '\\x1b8');",
    "let n = 0; process.stdout.write('ticker ready\\r\\n'); bar(); process.stdout.on('resize', bar);",
    "setInterval(() => { process.stdout.write('tick ' + (++n) + '\\r\\n'); bar(); }, 500);",
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(bHome, '.dorothy'), { recursive: true });
  fs.writeFileSync(path.join(bHome, '.dorothy', 'agents.json'), JSON.stringify([{
    id: AGENT.id, name: AGENT.name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-08T08:00:00.000Z', lastActivity: '2026-10-08T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(bHome, '.dorothy', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false }));
  return { aHome, bHome, received };
}

type AgentApi = { electronAPI: { agent: {
  start: (p: { id: string; prompt: string }) => Promise<unknown>;
  get: (id: string) => Promise<{ status: string; output: string[]; stoppedBy?: string; stopReason?: string; cliRunning?: boolean } | null>;
} } };
const agentOn = (page: Page) => page.evaluate((id) => (window as unknown as AgentApi).electronAPI.agent.get(id), AGENT.id);

/** B's Dashboard, and its agent started and ticking. */
async function startTicker(b: { page: Page }, values: Record<string, unknown>) {
  await b.page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
  await splashGone(b.page);
  const started = await b.page.evaluate((id) => (window as unknown as AgentApi).electronAPI.agent.start({ id, prompt: '' }), AGENT.id);
  values.startOnPc = started;
  await expect.poll(async () => (await agentOn(b.page))?.output.join('') ?? '', {
    timeout: 30_000, message: `the PC's agent prints its ticks (start answered ${JSON.stringify(started)})`,
  }).toContain('tick');
}

async function launch(home: string, me: typeof A, viewport = { width: 1440, height: 900 }): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchSandboxed(electron, home, { env: {
    NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: me.api, DOROTHY_E2E: '1',
    TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: me.bridge,
  } });
  const page = await app.firstWindow();
  await page.setViewportSize(viewport);
  return { app, page };
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

test('a paired machine\'s agents show on the Dashboard with its badge, live and read only, and say when it goes offline', async () => {
  test.setTimeout(300_000);
  const { aHome, bHome, received } = twoHomes('see', 'see');
  const values: Record<string, unknown> = {};
  // A smaller window than A's, so B's terminal is not the size A's pane would fit itself to.
  const b = await launch(bHome, B, { width: 1100, height: 680 });
  const a = await launch(aHome, A);
  try {
    await startTicker(b, values);

    // 1. A's Dashboard shows B's agent, badged with B's name.
    await a.page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await splashGone(a.page);
    const terminal = await terminalOf(a.page, AGENT.name);
    await expect(a.page.locator('[data-machine-badge]').filter({ hasText: 'PC' }).first()).toBeVisible();
    values.badge = 'PC';

    // 2. Its terminal, and then more of it.
    const rows = terminal.locator('.xterm-rows');
    await expect(rows).toContainText('tick', { timeout: 30_000 });
    const first = Math.max(...ticksIn(await rows.innerText()));
    await expect.poll(async () => Math.max(...ticksIn(await rows.innerText())), { timeout: 15_000 }).toBeGreaterThan(first + 2);
    values.firstTick = first;
    values.laterTick = Math.max(...ticksIn(await rows.innerText()));
    await stepShot(a.page, '01-a-shows-the-pc-agent-live');

    // 2b. At the PC terminal's size (Mac and PC, 2026-10-09): as many rows, the
    // status bar its CLI draws on the last one, and the whole within its panel.
    type MachinesApi = { electronAPI: { machines: { agents: () => Promise<Array<{ agentId: string; cols?: number; rows?: number }>> } } };
    const remoteSize = async () => (await a.page.evaluate(() => (window as unknown as MachinesApi).electronAPI.machines.agents())).find(r => r.agentId === AGENT.id);
    await expect.poll(async () => (await remoteSize())?.rows ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    const size = (await remoteSize())!;
    const rowDivs = terminal.locator('.xterm-rows > div');
    await expect.poll(() => rowDivs.count(), { timeout: 10_000 }).toBe(size.rows);
    await expect.poll(async () => rowDivs.last().innerText(), { timeout: 10_000 }).toContain(`status bar ${size.cols}x${size.rows}`);
    const fit = await terminal.evaluate((xterm) => {
      const screen = (xterm.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
      const body = (xterm.parentElement as HTMLElement).getBoundingClientRect();
      return { screen: { w: screen.width, h: screen.height }, body: { w: body.width, h: body.height }, transform: getComputedStyle(xterm).transform };
    });
    expect(fit.screen.w, JSON.stringify(fit)).toBeLessThanOrEqual(fit.body.w + 1);
    expect(fit.screen.h, JSON.stringify(fit)).toBeLessThanOrEqual(fit.body.h + 1);
    values.pcTerminalSize = size;
    values.paneFit = fit;

    // 3. Read only: keys typed into A's pane never reach B's CLI.
    await terminal.locator('.xterm-screen').click();
    await a.page.keyboard.type('nope');
    await a.page.waitForTimeout(1_500);
    expect(fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '').not.toContain('nope');
    values.typedNothingReachedThePc = true;

    // 4. B goes away: A says since when, and keeps the last output.
    const lastSeen = Math.max(...ticksIn(await rows.innerText()));
    await b.app.close();
    const offline = a.page.locator('[data-machine-offline]');
    await expect(offline).toBeVisible({ timeout: 20_000 });
    await expect(offline).toHaveText(/^PC offline since \d{2}:\d{2}\. Its last output stays below, and the pane is live again when the PC is back\.$/);
    expect(ticksIn(await rows.innerText())).toContain(lastSeen);
    values.offlineLine = await offline.textContent();
    await stepShot(a.page, '02-a-says-the-pc-is-offline');
    recordValues(values);
  } finally {
    await a.app.close();
    await b.app.close().catch(() => {});
    for (const home of [aHome, bHome]) await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

test('a paired machine that lets this one drive: what is typed in its pane goes to its agent as typed, a stop filed with its reason, a start, and see only refused with its sentence', async () => {
  test.setTimeout(300_000);
  const { aHome, bHome, received } = twoHomes('drive', 'drive');
  const values: Record<string, unknown> = {};
  const b = await launch(bHome, B, { width: 1100, height: 680 });
  const a = await launch(aHome, A);
  try {
    await startTicker(b, values);
    await a.page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await splashGone(a.page);
    const terminal = await terminalOf(a.page, AGENT.name);
    await expect(terminal.locator('.xterm-rows')).toContainText('tick', { timeout: 30_000 });

    // 5. Typed in A's pane, as typed in B's CLI: no bar, the keys themselves.
    await expect(a.page.locator('[data-machine-message]')).toHaveCount(0);
    await terminal.locator('.xterm-screen').click();
    await a.page.keyboard.type('hello from the mac');
    await a.page.keyboard.press('Enter');
    await a.page.keyboard.press('Escape');
    const readTyped = () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '');
    await expect.poll(readTyped, { timeout: 15_000 }).toContain('hello from the mac\r');
    await expect.poll(readTyped, { timeout: 15_000 }).toContain('\u001b');
    expect(readTyped()).not.toContain('Message from');
    values.keysTypedOnPc = JSON.stringify(readTyped());
    await stepShot(a.page, '03-a-types-into-the-pc-agent');

    // 5b. The terminal draws for whoever looks at it (Nicolas, 2026-10-09): B's
    // terminal takes A's pane's size, which fills its body unscaled, and B's
    // CLI is told (its status bar says the size on its last row).
    type Sized = { electronAPI: { machines: { agents: () => Promise<Array<{ agentId: string; cols?: number; rows?: number }>> } } };
    const fleetSize = async () => {
      const remote = (await a.page.evaluate(() => (window as unknown as Sized).electronAPI.machines.agents())).find(r => r.agentId === AGENT.id);
      return { cols: remote?.cols ?? 0, rows: remote?.rows ?? 0 };
    };
    const paneOf = (xterm: Locator) => xterm.evaluate((el) => {
      const screen = (el.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
      const body = (el.parentElement as HTMLElement).getBoundingClientRect();
      return { rows: el.querySelectorAll('.xterm-rows > div').length, screenH: screen.height, bodyH: body.height, transform: getComputedStyle(el).transform };
    });
    const pcPane = await terminalOf(b.page, AGENT.name);
    const pcRows = await pcPane.locator('.xterm-rows > div').count();
    const takesThePane = async (xterm: Locator, step: string) => {
      await expect.poll(async () => (await fleetSize()).rows, { timeout: 15_000, message: `${step}: the PC terminal takes the pane's rows` }).toBe((await paneOf(xterm)).rows);
      const pane = await paneOf(xterm);
      const size = await fleetSize();
      expect(pane.transform, step).toBe('none');
      // Filled to within one row: fitted, not drawn small in a corner.
      expect(pane.screenH, JSON.stringify(pane)).toBeGreaterThan(pane.bodyH - 2 * (pane.screenH / pane.rows));
      await expect.poll(async () => xterm.locator('.xterm-rows > div').last().innerText(), { timeout: 10_000 }).toContain(`status bar ${size.cols}x${size.rows}`);
      return { pane, size };
    };
    const inGrid = await takesThePane(terminal, '5b');
    expect(inGrid.size.rows, 'A\'s pane is not the PC\'s own size').not.toBe(pcRows);
    values.pcPaneRows = pcRows;
    values.sharedInGrid = inGrid;
    await stepShot(a.page, '03b-the-pc-terminal-at-the-mac-pane-size');

    // 5c. Fullscreen: the pane grows, and so does B's terminal, text at the same size.
    await a.page.getByRole('button', { name: 'Fullscreen', exact: true }).first().click();
    const full = await takesThePane(await terminalOf(a.page, AGENT.name), '5c');
    expect(full.size.rows).toBeGreaterThanOrEqual(inGrid.size.rows);
    values.sharedFullscreen = full;
    await stepShot(a.page, '03c-fullscreen');
    await a.page.getByRole('button', { name: 'Exit fullscreen', exact: true }).first().click();
    const back = await takesThePane(await terminalOf(a.page, AGENT.name), '5c restored');
    values.sharedRestored = back;

    // 5d. B takes it back with a click in its own pane: its terminal is B's size again.
    await pcPane.locator('.xterm-screen').click();
    await expect.poll(async () => (await fleetSize()).rows, { timeout: 15_000, message: 'the PC takes its size back' }).toBe(pcRows);
    values.pcTookItBack = await fleetSize();
    await stepShot(b.page, '03d-the-pc-takes-its-size-back');

    // 6. A stop needs its reason, and B files it under A's name.
    await a.page.getByRole('button', { name: 'stop', exact: true }).first().click();
    const reason = a.page.locator('[data-machine-stop-reason]');
    await expect(reason).toBeVisible();
    await reason.fill('night');
    await reason.press('Enter');
    await expect.poll(async () => {
      const agent = await agentOn(b.page);
      return agent && { status: agent.status, stoppedBy: agent.stoppedBy, stopReason: agent.stopReason };
    }, { timeout: 15_000 }).toEqual({ status: 'stopped', stoppedBy: 'Mac (machine)', stopReason: 'night' });
    values.stoppedOnPc = { stoppedBy: 'Mac (machine)', stopReason: 'night' };

    // 7. A start runs it again.
    const startButton = a.page.getByRole('button', { name: /^(start|session)$/ }).first();
    await expect.poll(async () => (await startButton.isEnabled()), { timeout: 10_000 }).toBe(true);
    await startButton.click();
    // Its CLI runs again, and no sentence came back saying why not.
    await expect.poll(async () => (await agentOn(b.page))?.cliRunning, { timeout: 30_000 }).toBe(true);
    await expect(a.page.locator('[data-machine-drive-error]')).toHaveCount(0);
    values.startedAgainOnPc = true;

    // 8. B takes Drive back: A may only see, and an action asked anyway is refused with B's sentence.
    letA(bHome, 'see');
    await expect(a.page.locator('[data-machine-see-only]')).toBeVisible({ timeout: 15_000 });
    await expect(a.page.getByRole('button', { name: /^(stop|start)$/ }).first()).toBeDisabled();
    // Typed in the pane: nothing goes. Asked of the bridge anyway: B refuses with its sentence.
    await terminal.locator('.xterm-screen').click();
    await a.page.keyboard.type('still there?');
    type MachinesApi = { electronAPI: { machines: { typeKeys: (id: string, data: string) => Promise<unknown>; agents: () => Promise<Array<{ id: string; agentId: string }>> } } };
    const refused = await a.page.evaluate(async (agentId) => {
      const api = (window as unknown as MachinesApi).electronAPI.machines;
      const remote = (await api.agents()).find(r => r.agentId === agentId)!;
      return api.typeKeys(remote.id, 'anyway\r');
    }, AGENT.id);
    expect(refused).toEqual({ success: false, error: 'PC lets Mac see only.' });
    await a.page.waitForTimeout(1_000);
    expect(readTyped()).not.toContain('still there?');
    expect(readTyped()).not.toContain('anyway');
    values.seeOnlyRefused = refused;
    await stepShot(a.page, '04-a-may-only-see');
    recordValues(values);
  } finally {
    await a.app.close();
    await b.app.close().catch(() => {});
    for (const home of [aHome, bHome]) await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
