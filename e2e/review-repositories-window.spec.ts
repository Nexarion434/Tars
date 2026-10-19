import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Review page lists every repository of every project, and searches them all (2.0.4, the window's part of
 * #472). Frames: `Review · projects and their repositories` (its light copy, the narrowest window), `· search`,
 * `· a folder with no git` (and its light copy), `· states` (and its light copy).
 *
 * The real app on a sandbox HOME with three projects added in Tars: meridian, holding three repositories at three
 * depths, two with a change; field-notes, with no git; old-shop, a folder gone. Finder is stood in for in the main
 * process. Asserted, once with the classic shell and once with the new interface:
 * 1. meridian lists its three repositories under MERIDIAN · 3 REPOSITORIES, each with its branch, and says which
 *    changed, 2 in all.
 * 2. field-notes says once that it has no git, and picked, explains it with its folder to show.
 * 3. old-shop says its folder is gone; remove from Tars asks once, then takes it out of Tars's list, its folder name
 *    alone, nothing on disk.
 * 4. A repository picked: its title, its branch against main and how far ahead, its files; a file picked, its patch.
 * 5. Search: a changed file of any repository, picked, opens that repository and that file; a word found nowhere says
 *    so, naming how many repositories and projects were searched.
 * Red on 1953bd6f (#472's head, the page before this): no repository of meridian in the list.
 * The artefact: values.json (the rows read, what Tars would have opened, the projects left), the screenshots, and with
 * E2E_TRACE=on the app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function repo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

async function standInForFinder(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __e2eOpened: string[] };
    g.__e2eOpened = [];
    shell.openPath = (async (p: string) => { g.__e2eOpened.push(p); return ''; }) as typeof shell.openPath;
    shell.showItemInFolder = ((p: string) => { g.__e2eOpened.push(p); }) as typeof shell.showItemInFolder;
  });
}
const opened = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened);

const repositories = (page: Page) => page.getByRole('navigation', { name: 'Repositories' });
const repoRow = (page: Page, name: string) => repositories(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';

  test(`review lists every repository of every project, says a folder with no git or gone, and searches them all${shell}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-review-window-${newInterface ? 'ni' : 'classic'}-`));
    const dir = path.join(home, '.dorothy');
    const meridian = path.join(home, 'projects', 'meridian');
    const fieldNotes = path.join(home, 'projects', 'field-notes');
    const oldShop = path.join(home, 'projects', 'old-shop');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(fieldNotes, { recursive: true });
    fs.writeFileSync(path.join(fieldNotes, 'notes.txt'), 'no git here');
    const contracts = repo(path.join(meridian, 'contracts'));
    const sdk = repo(path.join(meridian, 'sdk-js'));
    repo(path.join(meridian, 'services', 'a', 'b', 'indexer'));
    fs.writeFileSync(path.join(contracts, 'README.md'), '# r\nchanged\n');
    git(sdk, 'checkout', '-q', '-b', 'feat/indexer');
    fs.mkdirSync(path.join(sdk, 'src', 'indexer'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export {};\n');
    git(sdk, 'add', '-A');
    git(sdk, 'commit', '-q', '-m', 'client');
    fs.writeFileSync(path.join(sdk, 'src', 'indexer', 'client.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([meridian, fieldNotes, oldShop]));
    fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31562 : 31561), DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    try {
      await standInForFinder(app);
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. meridian's repositories, each with its branch, 2 changed.
      const list = repositories(page);
      await expect(list).toContainText('MERIDIAN · 3 REPOSITORIES', { timeout: 60_000 });
      await expect(list).toContainText('2 changed');
      await expect(repoRow(page, 'contracts')).toContainText('main');
      await expect(repoRow(page, 'contracts')).toContainText('1 changed');
      await expect(repoRow(page, 'sdk-js')).toContainText('feat/indexer');
      await expect(repoRow(page, 'services/a/b/indexer')).toContainText('clean');
      keep({ rows: await list.getByRole('button').allInnerTexts() });
      await stepShot(page, '01-repositories');

      // 2. field-notes: no git, said once, explained when picked.
      await expect(list).toContainText('No git here: not a repository, and none inside.');
      await list.getByRole('button', { name: /No git here/ }).click();
      await expect(page.getByRole('heading', { name: 'field-notes is not under git' })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'show folder', exact: true }).click();
      await expect.poll(async () => (await opened(app)).at(-1) ?? '', { timeout: 10_000 }).toBe(fieldNotes);
      await stepShot(page, '02-no-git');

      // 3. old-shop: gone, removed from Tars after one question, nothing on disk.
      await expect(list).toContainText('is gone: moved, renamed or deleted.');
      await list.getByRole('button', { name: 'remove from Tars', exact: true }).click();
      const ask = page.getByRole('alertdialog', { name: 'Remove old-shop from Tars' });
      await expect(ask).toContainText('Nothing on your disk changes.');
      await stepShot(page, '03-remove-asks');
      await ask.getByRole('button', { name: 'remove', exact: true }).click();
      await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')) as string[], { timeout: 15_000 }).toEqual([meridian, fieldNotes]);
      await expect(list).not.toContainText('OLD-SHOP');

      // 4. A repository and a file.
      await repoRow(page, 'sdk-js').click();
      const files = page.getByRole('region', { name: 'Changed files' });
      await expect(files).toContainText('meridian / sdk-js', { timeout: 15_000 });
      await expect(files).toContainText('feat/indexer vs main · 1 commit ahead');
      await files.getByRole('button', { name: /src\/indexer\/client\.ts/ }).click();
      await expect(page.getByText('+export const a = 1;', { exact: true })).toBeVisible({ timeout: 15_000 });
      await stepShot(page, '04-repository-and-file');

      // 5. Search: a changed file anywhere, picked; then a word found nowhere.
      const search = page.getByRole('searchbox', { name: 'Search every repository and changed file' });
      await search.fill('client');
      await expect(list).toContainText('RESULTS · EVERY PROJECT, NO LIMIT', { timeout: 15_000 });
      await list.getByRole('button', { name: /sdk-js\/src\/indexer\/client\.ts/ }).click();
      await expect(files).toContainText('meridian / sdk-js', { timeout: 15_000 });
      await expect(page.getByText('+export const a = 1;', { exact: true })).toBeVisible({ timeout: 15_000 });
      await stepShot(page, '05-search');
      await search.fill('fetchTicker');
      await expect(list).toContainText('Nothing named fetchTicker in the 3 repositories of your 2 projects, nor in their changed files.', { timeout: 15_000 });
      await stepShot(page, '06-search-nothing');

      keep({ opened: await opened(app), projectsLeft: JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8')), oldShopOnDisk: fs.existsSync(oldShop), pageErrors: errors });
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close().catch(() => { /* gone */ });
      await removeHome(home);
    }
  });
}
