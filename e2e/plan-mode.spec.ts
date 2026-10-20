import { test, expect, _electron as electron, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Plan, a permission mode (PR B, #364, launches claude with
 * --permission-mode plan; the other CLIs read plan as normal). Frames: `Overlay
 * · New agent · Options open` and `Permissions · plan mode · states`.
 *
 * A sandbox with one project and two agents that are not started: Planner, on
 * Claude Code in plan, and Codex worker. Both CLIs are stand-ins that write
 * the arguments they were started with into a file, so nothing real runs.
 *
 * The person opens Planner's window: its Skills tab shows plan chosen. Codex
 * worker's window: plan dimmed, with its reason. New agent: Options offers
 * plan first; chosen, then OpenRouter as the provider, plan is dimmed with its
 * reason and the choice falls back to manual; back on Claude Code, plan is
 * chosen again and the agent is created and started. agents.json says plan,
 * and the stand-in was started with --permission-mode plan.
 *
 * The artefact: a screenshot per state and values.json with what each read.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

test('plan, a permission mode: chosen for Claude Code in New agent and passed to its CLI, dimmed with its reason for another CLI, and shown in an agent\'s window', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-plan-mode-'));
  const real = fs.realpathSync(home);
  const project = path.join(real, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const argsFile = path.join(real, 'stand-in-args.jsonl');
  // In Node, not bash: a bash stand-in is named like the shell in the pty's
  // foreground, and the app would never see a CLI running.
  const standIn = (name: string) => {
    const file = path.join(real, name);
    fs.writeFileSync(file, [
      `#!${process.execPath}`,
      `require('fs').appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'), { mode: 0o755 });
    return file;
  };
  const claude = standIn('claude-stand-in.cjs');
  const codex = standIn('codex-stand-in.cjs');
  const agent = (o: Record<string, unknown>) => ({
    character: 'robot', status: 'idle', skills: [], projectPath: project, role: 'worker',
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...o,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent({ id: 'p1', name: 'Planner', provider: 'claude', permissionMode: 'plan', cliPath: claude }),
    agent({ id: 'c1', name: 'Codex worker', provider: 'codex', permissionMode: 'normal', cliPath: codex }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    cliPaths: { claude, codex },
    openRouterEnabled: true, openRouterApiKey: 'sk-e2e-not-a-key',
  }));
  // The seed writes a bare array; the app saves { version, savedAt, agents }.
  const onDisk = () => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as unknown;
    return (Array.isArray(raw) ? raw : (raw as { agents: unknown[] }).agents) as Array<Record<string, unknown>>;
  };
  const startedWith = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]) : []);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31452), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });

    const modes = (scope: Locator) => scope.getByRole('radiogroup', { name: 'Permission mode' });
    const windowModes = async (name: string) => {
      await page.getByText(name, { exact: true }).first().click();
      const dialog = page.getByRole('dialog').last();
      await dialog.getByRole('radiogroup', { name: 'Agent rail' }).getByRole('radio', { name: 'Skills', exact: true }).click();
      return { dialog, group: modes(dialog) };
    };

    // An agent's window: Planner's Skills tab shows plan chosen.
    {
      const { dialog, group } = await windowModes('Planner');
      await expect(group.getByRole('radio', { name: 'Plan', exact: true })).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
      seen.windowPlanner = await group.getByRole('radio').evaluateAll(els => els.map(e => `${e.textContent}${e.getAttribute('aria-checked') === 'true' ? '*' : ''}`));
      await stepShot(page, '01-window-planner');
      await dialog.getByRole('button', { name: 'close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }

    // Codex worker's window: plan dimmed, with its reason.
    {
      const { dialog, group } = await windowModes('Codex worker');
      const plan = group.getByRole('radio', { name: 'Plan', exact: true });
      await expect(plan).toBeDisabled({ timeout: 30_000 });
      await expect(plan).toHaveAttribute('title', 'Codex has no plan mode here: plan would run as manual.');
      await expect(group.getByRole('radio', { name: 'Manual', exact: true })).toHaveAttribute('aria-checked', 'true');
      seen.windowCodex = await plan.getAttribute('title');
      await stepShot(page, '02-window-codex');
      await dialog.getByRole('button', { name: 'close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }

    // New agent: Options offers plan first.
    await page.getByRole('button', { name: '+ Agent', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New agent', exact: true }) });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'demo' }).first().click();
    await modal.getByRole('button', { name: /Options/ }).first().click();
    const group = modes(modal);
    seen.newAgentModes = await group.getByRole('radio').allInnerTexts();
    expect(seen.newAgentModes).toEqual(['plan', 'manual', 'auto', 'bypass']);
    await group.getByRole('radio', { name: 'plan', exact: true }).click();
    await expect(group.getByRole('radio', { name: 'plan', exact: true })).toHaveAttribute('aria-checked', 'true');
    await stepShot(page, '03-new-agent-plan');

    // OpenRouter: plan dimmed with its reason, and the choice falls back to manual.
    await modal.getByRole('button', { name: 'Another provider', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'OpenRouter' }).first().click();
    const dimmed = group.getByRole('radio', { name: 'plan', exact: true });
    await expect(dimmed).toBeDisabled();
    await expect(dimmed).toHaveAttribute('title', 'OpenRouter has no plan mode here: plan would run as manual.');
    await expect(group.getByRole('radio', { name: 'manual', exact: true })).toHaveAttribute('aria-checked', 'true');
    seen.openRouterPlan = await dimmed.getAttribute('title');
    await stepShot(page, '04-new-agent-openrouter');

    // Back on Claude Code: plan again, then create and start.
    await modal.getByRole('button').filter({ hasText: 'Claude' }).first().click();
    await group.getByRole('radio', { name: 'plan', exact: true }).click();
    await expect(group.getByRole('radio', { name: 'plan', exact: true })).toHaveAttribute('aria-checked', 'true');
    // The Agents page starts a new agent only with a task (an empty one is created and left to start by hand).
    await modal.getByPlaceholder('Describe what you want done.').fill('Read the project and say what you would change.');
    const before = startedWith().length;
    await modal.getByRole('button', { name: 'Create and start', exact: true }).click();
    await expect.poll(() => onDisk().length, { timeout: 30_000 }).toBe(3);
    const created = onDisk().find(a => a.id !== 'p1' && a.id !== 'c1');
    seen.created = { provider: created?.provider, permissionMode: created?.permissionMode };
    expect(created).toMatchObject({ provider: 'claude', permissionMode: 'plan' });
    // The app also runs the CLI for its own probes (a version, and so on), which
    // the stand-in records too: the launch is the run given a permission mode.
    const launch = () => startedWith().slice(before).find(args => args.includes('--permission-mode'));
    await expect.poll(() => !!launch(), { timeout: 60_000, message: 'the stand-in was launched as the agent' }).toBe(true);
    seen.startedWith = startedWith().slice(before);
    const argv = launch()!;
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    await stepShot(page, '05-created');

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    // What the stand-ins were started with, kept beside the screenshots.
    if (fs.existsSync(argsFile)) fs.copyFileSync(argsFile, test.info().outputPath('stand-in-args.jsonl'));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
