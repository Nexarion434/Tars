import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The install counts on the Extensions page, written as the frame
 * `Extensions · Skills` writes them: one decimal always, in K or M ("3.0M",
 * "27.9K", "2.0K").
 *
 * On 12/10 the page read "1113K" beside "1300.1K": the main process formats
 * the count into a text, drops a ".0" and knows no unit above K, so a count on
 * a round thousand lost its decimal and every count past a million read in
 * thousands. The listing it keeps on disk holds those texts, and serves them
 * at once for an hour after a fetch.
 *
 * skills.sh is answered from here, where the request is (the main process, as
 * stubSkillsSh in fixture.mjs does), with counts of that kind: two past a
 * million, one on a round thousand past a million, one that rounds up into
 * the next unit, one on a round thousand under a million, a small round
 * thousand, and one under a thousand. Everything downstream of the network is
 * the real code: the scraping, the listing main keeps, the page.
 *
 * The artefact: a screenshot of the list and values.json with each row's count.
 */

/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

const ROWS: Array<[name: string, repo: string, installs: number, shown: string]> = [
  ['find-skills', 'vercel-labs/skills', 3_731_100, '3.7M'],
  ['grill-me', 'mattpocock/skills', 1_300_100, '1.3M'],
  ['grill-with-docs', 'mattpocock/skills', 1_113_000, '1.1M'],
  ['agent-browser', 'vercel-labs/agent-browser', 999_950, '1.0M'],
  ['handoff', 'mattpocock/skills', 933_000, '933.0K'],
  ['triage', 'mattpocock/skills', 2_000, '2.0K'],
  ['remember', 'cooper-labs-tech/Tars', 940, '940'],
];

/** One line, because the scraper's regex does not cross a newline. */
const PAGE = `<!doctype html><html><body><script>window.initialSkills = ${
  JSON.stringify(ROWS.map(([name, source, installs]) => ({ source, name, installs })))
}</script></body></html>`;

test('the Extensions page writes every install count with one decimal, in K or M, as the frame does', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-install-counts-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31456), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    await app.evaluate(async (_electron, html) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String((input as Request)?.url ?? input);
        if (url.includes('skills.sh')) {
          return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return realFetch(input, init);
      }) as typeof fetch;
    }, PAGE);

    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/skills`, { waitUntil: 'domcontentloaded' });

    const rows = page.locator('tbody tr');
    await expect(rows.filter({ hasText: 'grill-with-docs' })).toHaveCount(1, { timeout: 90_000 });
    const shown: Record<string, string> = {};
    for (const [name] of ROWS) {
      const row = rows.filter({ has: page.getByText(name, { exact: true }) });
      shown[name] = (await row.locator('td').nth(3).innerText()).trim();
    }
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
    recordValues({ shown, expected: Object.fromEntries(ROWS.map(([name, , , label]) => [name, label])) });
    await stepShot(page, '01-install-counts');

    expect(shown).toEqual(Object.fromEntries(ROWS.map(([name, , , label]) => [name, label])));
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});
