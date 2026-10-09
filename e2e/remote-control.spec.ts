import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, splashGone, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Remote Control (Nicolas, 2026-10-09): one switch in Settings, under Claude
 * Code's configure, and each Claude agent started after it starts as
 * `claude --remote-control <its name>`, reachable from the Claude app on his
 * phone under that name.
 *
 * Asserted, in the real app, the CLI a recorder that writes down its argv:
 * 1. The switch is off at first, and an agent started then gets no
 *    `--remote-control`.
 * 2. Turned on in Settings > Providers > Claude Code > configure, it is saved.
 * 3. An agent started after it gets `--remote-control` and its title, its
 *    project's folder then its own name ("demo · Ana's landing $HOME"), as one
 *    argument (a quote and `$HOME` reach the CLI as typed), and its task is
 *    still the prompt.
 * Leaves a run directory with the switch's picture and the argv of each start.
 *   npx playwright test e2e/remote-control.spec.ts
 */

const onWindows = process.platform === 'win32';
const NAME = "Ana's landing $HOME";
const TASK = 'Say hi';

type Launch = { argv: string[]; agentId: string | null };
type Api = { electronAPI: { agent: {
  create(config: Record<string, unknown>): Promise<{ id: string }>;
  start(params: { id: string; prompt: string }): Promise<{ success: boolean; error?: string }>;
} } };

/** One JSON line per start, then a prompt it holds, like a CLI waiting. */
function recorderScript(log: string): string {
  return [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), agentId: process.env.CLAUDE_AGENT_ID || null }) + '\\n');`,
    "process.stdout.write('the recorder of the remote control spec\\r\\n> ');",
    'process.stdin.resume();',
    '',
  ].join('\n');
}

/** The recorder as an agent's CLI path: a shebang file, or on Windows npm's cmd-shim in front of it. */
function installRecorder(home: string, log: string): string {
  const dir = path.join(home, 'npm dir');
  const pkg = path.join(dir, 'node_modules', 'fake-claude');
  fs.mkdirSync(pkg, { recursive: true });
  if (!onWindows) {
    const file = path.join(dir, 'fake-claude.cjs');
    fs.writeFileSync(file, `#!${process.execPath}\n${recorderScript(log)}`, { mode: 0o755 });
    return file;
  }
  fs.writeFileSync(path.join(pkg, 'cli.js'), recorderScript(log));
  const shim = path.join(dir, 'fake-claude.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*', '',
  ].join('\r\n'));
  return shim;
}

async function launchOf(log: string, agentId: string): Promise<Launch> {
  const all = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Launch) : []);
  await expect.poll(() => all().some(l => l.agentId === agentId), { timeout: 30_000, message: `the recorder never started for ${agentId}` }).toBe(true);
  return all().find(l => l.agentId === agentId)!;
}

/** What follows `--remote-control` before `--`, or null without it. */
function remoteControlOf(argv: string[]): string | null {
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  const at = options.indexOf('--remote-control');
  return at === -1 ? null : options[at + 1] ?? '';
}

async function startAgent(page: Page, project: string, cli: string, name: string): Promise<string> {
  const id = await page.evaluate(async (arg) => {
    const api = (window as unknown as Api).electronAPI.agent;
    const agent = await api.create({ projectPath: arg.project, skills: [], name: arg.name, cliPath: arg.cli, permissionMode: 'normal' });
    const started = await api.start({ id: agent.id, prompt: arg.task });
    if (!started.success) throw new Error(started.error ?? 'start failed');
    return agent.id;
  }, { project, cli, name, task: TASK });
  return id;
}

test('with Remote Control on in Settings, a Claude agent starts with --remote-control under its project and name', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-remote-control-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  const log = path.join(home, 'launches.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const cli = installRecorder(home, log);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }, null, 2));
  const settingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'app-settings.json'), 'utf8')) as Record<string, unknown>;

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31456), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const values: Record<string, unknown> = { platform: process.platform };
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Api).electronAPI?.agent), { timeout: 60_000 }).toBe(true);

    // 1. Off at first: an agent started now gets no --remote-control.
    const before = await launchOf(log, await startAgent(page, project, cli, 'Started before'));
    expect(remoteControlOf(before.argv), JSON.stringify(before.argv)).toBeNull();
    values.argvOff = before.argv;

    // 2. Turned on under Claude Code's configure, and saved.
    await page.getByText('AI & Providers', { exact: true }).click();
    await page.getByText('Providers', { exact: true }).first().click();
    await page.getByRole('button', { name: 'configure' }).first().click();
    const toggle = page.getByRole('switch', { name: 'Remote Control' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => settingsOnDisk().remoteControlEnabled, { timeout: 10_000 }).toBe(true);
    await toggle.scrollIntoViewIfNeeded();
    await stepShot(page, '01-remote-control-on');

    // 3. An agent started now: --remote-control, its own name as one argument, and the task still the prompt.
    const after = await launchOf(log, await startAgent(page, project, cli, NAME));
    expect(remoteControlOf(after.argv), JSON.stringify(after.argv)).toBe(`demo · ${NAME}`);
    expect(after.argv.slice(after.argv.indexOf('--') + 1)).toEqual([TASK]);
    values.argvOn = after.argv;

    expect(errors, errors.join('\n')).toEqual([]);
    recordValues(values);
  } finally {
    await app.close();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
