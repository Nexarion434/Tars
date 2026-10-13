import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Deleting an agent from the Agents page says what stays of it (2.0.1), as the chat list does
 * since 2.0.0. agent:remove answers savedTo, the wip/ branch its uncommitted work was saved on,
 * and worktreeKept, why its worktree stays on disk and where; the page read neither, and its
 * confirm said the uncommitted changes went with the worktree, which has not been true since
 * #312. Frame: `Agents · an agent deleted, what stays and where`, in tars-redesign.pen.
 *
 * A sandbox HOME with one project in git, whose main has a .gitignore naming .env, and two
 * agents whose CLI is a stand-in waiting on its input: Backend Engineer, on its own worktree,
 * which holds a change it never committed, a new file and a .env; and Night Worker, with none.
 * 1. Night Worker deleted from its card: the confirm, accepted; it goes, and the page says
 *    nothing, since nothing of it stays.
 * 2. Backend Engineer deleted from its card: the confirm says its 2 uncommitted changes are saved
 *    on a wip/ branch before its worktree goes, and never that they go with it; accepted, the page
 *    says its worktree was kept, why and where, and that its work is on wip/backend-engineer; on
 *    disk the folder and the branch are there; ok puts the notice away.
 *
 * The artefact: a screenshot per state, and values.json with the confirms, the notice and the
 * git state read after.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

test('deleting an agent from its card says what of it stays and where, and its confirm says the work is saved first', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-delete-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.env\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  const wt = path.join(project, '.worktrees', 'feat-backend');
  git(project, 'worktree', 'add', '-q', wt, '-b', 'feat/backend');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nwork in progress\n');
  fs.writeFileSync(path.join(wt, 'notes.md'), 'not committed\n');
  fs.writeFileSync(path.join(wt, '.env'), 'TOKEN=e2e\n');

  const cli = path.join(home, 'waiting-cli.cjs');
  fs.writeFileSync(cli, [`#!${process.execPath}`, "process.stdout.write('ready\\n');", 'process.stdin.resume();', ''].join('\n'), { mode: 0o755 });
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('be', 'Backend Engineer', { worktreePath: wt, branchName: 'feat/backend' }),
    agent('nw', 'Night Worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31439), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    const confirms: string[] = [];
    page.on('dialog', async (dialog) => {
      confirms.push(dialog.message());
      await dialog.accept();
    });
    const card = (id: string) => page.locator(`[data-agent-card="${id}"]`);
    const deleted = page.locator('[data-agent-deleted]');
    await expect(card('be')).toBeVisible({ timeout: 60_000 });
    await expect(card('nw')).toBeVisible();
    await stepShot(page, '01-agents');

    // 1. An agent of which nothing stays: deleted, and nothing said.
    await card('nw').getByRole('button', { name: 'delete', exact: true }).click();
    await expect(card('nw')).toHaveCount(0, { timeout: 30_000 });
    expect(confirms[0]).toContain('Delete "Night Worker"?');
    await page.waitForTimeout(1000);
    await expect(deleted, 'nothing of it stays: nothing is said').toHaveCount(0);

    // 2. Backend Engineer: its confirm says the work is saved first, then what stays and where.
    await card('be').getByRole('button', { name: 'delete', exact: true }).click();
    await expect(card('be')).toHaveCount(0, { timeout: 60_000 });
    seen.confirms = confirms;
    expect(confirms[1]).toContain('Delete "Backend Engineer"?');
    expect(confirms[1]).toContain('Its 2 uncommitted changes are saved on a wip/ branch first');
    expect(confirms[1]).not.toContain('will be deleted, along with');
    await expect(deleted).toBeVisible({ timeout: 30_000 });
    await expect(deleted).toContainText(
      `Deleted Backend Engineer, but not its worktree: it holds files git ignores, which no commit keeps (.env), so its worktree was kept at ${wt}.`,
    );
    await expect(deleted).toContainText('Its uncommitted work is on the branch wip/backend-engineer.');
    seen.notice = (await deleted.innerText()).replace(/\s+/g, ' ').trim();
    seen.disk = {
      envKept: fs.existsSync(path.join(wt, '.env')),
      wipNotes: git(project, 'show', 'wip/backend-engineer:notes.md'),
      wipA: git(project, 'show', 'wip/backend-engineer:a.txt'),
    };
    expect(seen.disk).toEqual({ envKept: true, wipNotes: 'not committed', wipA: 'one\nwork in progress' });
    await stepShot(page, '02-deleted-what-stays');
    await deleted.getByRole('button', { name: 'ok', exact: true }).click();
    await expect(deleted).toHaveCount(0);
    await stepShot(page, '03-put-away');

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await removeHome(home);
  }
});
