import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A project whose memory an older Tars kept under a folder name Claude never
 * reads (#375), on Brain's Projects tab. Frame: `Brain · Projects · a row with
 * an older copy · states`.
 *
 * A project `my_proj` whose agent an older Tars filed under
 * `/` and `.` to `-` (the `_` kept, where Claude writes `-`): its MEMORY.md and
 * a topic file there, and no folder of Claude's yet. The page lists it once,
 * Claude's folder now holding both files, and the row names the older folder
 * on its third line, its whole path on hover. The older folder is kept.
 *
 * The artefact: a screenshot of the row and values.json with what it read.
 */

const PROJECT_ROW = 'button';

/**
 * Removes the sandbox HOME, again from a fresh listing while something still
 * writes into it: a CLI probe the app ran can write there after the close
 * (ENOTEMPTY), as in e2e/claude-accounts-settings.spec.ts.
 */
async function removeHome(home: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(home, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 20) throw err;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

test('a project whose memory an older Tars kept elsewhere is one row, which names the older folder', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-memory-older-'));
  const project = path.join(home, 'projects', 'my_proj');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'a1', name: 'Builder', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', skills: [],
    projectPath: project, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  // The older folder, as Tars named it before 1.9.6; Claude's own name for the project, as Claude writes it.
  const projects = path.join(home, '.claude', 'projects');
  const older = project.replace(/[/.]/g, '-');
  const olderMemory = path.join(projects, older, 'memory');
  const claudes = fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(olderMemory, { recursive: true });
  fs.writeFileSync(path.join(olderMemory, 'MEMORY.md'), '# my_proj\n\n- [Notes](notes.md): what the older Tars kept\n');
  fs.writeFileSync(path.join(olderMemory, 'notes.md'), 'The notes an older Tars kept under a folder Claude never reads.\n');
  expect(older).not.toBe(claudes);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31450), DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
    const tab = page.getByRole('radio', { name: 'Projects' });
    await expect(tab).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

    // One row for the project, Claude's, holding both files.
    const rows = page.locator(PROJECT_ROW, { hasText: 'my_proj' });
    await expect(rows).toHaveCount(1, { timeout: 60_000 });
    const row = rows.first();
    await expect(row).toContainText('2 files');

    // Its third line names the older folder, its whole path on hover.
    const line = row.getByText(`older copy in ${older}`, { exact: true });
    await expect(line).toBeVisible();
    await expect(line).toHaveAttribute('title', olderMemory);
    await stepShot(page, '01-row-with-an-older-copy');

    // Claude's folder holds the memory now, and the older folder is kept as it was.
    const claudesMemory = path.join(projects, claudes, 'memory');
    expect(fs.readFileSync(path.join(claudesMemory, 'MEMORY.md'), 'utf8')).toContain('# my_proj');
    expect(fs.existsSync(path.join(claudesMemory, 'notes.md'))).toBe(true);
    expect(fs.existsSync(path.join(olderMemory, 'MEMORY.md'))).toBe(true);

    recordValues({
      row: (await row.innerText()).replace(/\s+/g, ' ').trim(),
      olderFolder: older,
      claudesFolder: claudes,
      title: await line.getAttribute('title'),
      pageErrors: errors,
    });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
