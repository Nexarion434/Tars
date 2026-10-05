import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, stepShot, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two Tars, two homes, two bridges on 127.0.0.1: the development overrides
 * TARS_MACHINES_BIND / _PORT / _PEERS stand where the tailnet would. A shows a
 * code, B types it and waits; A is asked, nothing is written on either side
 * until A accepts; then both list the other as connected; A lets B drive,
 * which changes A's file only; B unpairs, and A forgets B too. Leaves a run
 * directory with each step's picture and the values asserted.
 *   E2E_PORT_OFFSET=90 npx playwright test e2e/machines-pairing.spec.ts
 */
const A = { api: apiPort(31481), bridge: apiPort(31491) };
const B = { api: apiPort(31483), bridge: apiPort(31493) };
// A bridge is never an API's port + 1: Tars's OpenAI bridge holds that one (OPENAI_BRIDGE_PORT).
const machinesFile = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'machines.json'), 'utf8'));

async function launch(name: string, me: typeof A, other: typeof A): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-machines-${name.toLowerCase()}-`));
  const app = await launchSandboxed(electron, home, { env: {
    NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: me.api, DOROTHY_E2E: '1',
    TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: me.bridge, TARS_MACHINES_PEERS: `127.0.0.1:${other.bridge}`,
  } });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/settings?section=machines`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  // Each Tars names itself, so the two lists can be told apart.
  const field = page.getByLabel('This machine', { exact: true });
  await expect(field).toBeVisible({ timeout: 30_000 });
  await field.fill(name);
  await field.blur();
  await expect.poll(() => machinesFile(home).self.name, { timeout: 10_000 }).toBe(name);
  return { app, page, home };
}

test('two Tars pair with a code once the one showing it accepts, see each other, and one unpairs', async () => {
  test.setTimeout(240_000);
  const a = await launch('Mac', A, B);
  const b = await launch('PC', B, A);
  const values: Record<string, unknown> = {};
  try {
    // A shows a code.
    await a.page.getByRole('button', { name: 'Add a machine', exact: true }).click();
    const notice = a.page.getByText(/^Pairing code \d{3} \d{3}\./);
    await expect(notice).toBeVisible({ timeout: 15_000 });
    const code = (await notice.textContent())!.match(/\d{3} \d{3}/)![0];
    values.codeShown = true;
    await stepShot(a.page, '01-a-shows-a-code');

    // B types it, and waits for A's answer.
    await b.page.getByLabel('Pair with a code', { exact: true }).fill(code);
    await b.page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(b.page.getByRole('button', { name: 'Waiting…', exact: true })).toBeVisible({ timeout: 15_000 });

    // A is asked, and neither side has written anything before A answers.
    const ask = a.page.getByText(/^PC wants to pair with this machine/);
    await expect(ask).toBeVisible({ timeout: 15_000 });
    // As the frame draws it: the request in place of the code, and a wait of a minute at most.
    await expect(a.page.getByText(/^Pairing code/)).toHaveCount(0);
    await expect(ask).toHaveText(/It waits (1:00|0:[0-5]\d) for your answer\.$/);
    values.askedInPlaceOfTheCode = true;
    expect(machinesFile(a.home).peers).toEqual([]);
    expect(machinesFile(b.home).peers).toEqual([]);
    values.nothingWrittenBeforeAccept = true;
    await stepShot(a.page, '02-a-is-asked');
    await stepShot(b.page, '03-b-waits');

    // A accepts.
    await a.page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(b.page.getByText('Paired with Mac.')).toBeVisible({ timeout: 20_000 });
    await expect(ask).toHaveCount(0, { timeout: 15_000 });
    await expect(a.page.getByText(/^Pairing code/)).toHaveCount(0, { timeout: 15_000 });

    // Both list the other, connected, within one poll.
    await expect(a.page.getByText('PC', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText('Mac', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(a.page.getByText('connected', { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(b.page.getByText('connected', { exact: true })).toBeVisible({ timeout: 25_000 });
    await stepShot(a.page, '04-a-lists-pc');
    await stepShot(b.page, '05-b-lists-mac');

    // A lets B drive: A's file says so, B's does not move.
    await a.page.getByRole('radio', { name: 'Drive' }).click();
    await expect.poll(() => machinesFile(a.home).peers[0]?.mayOnMe, { timeout: 10_000 }).toBe('drive');
    const aFile = machinesFile(a.home);
    const bFile = machinesFile(b.home);
    values.aMayB = aFile.peers[0].mayOnMe;
    values.bMayA = bFile.peers[0].mayOnMe;
    expect(bFile.peers[0].mayOnMe).toBe('see');
    // Each side keeps the secret it presents, and only the hash of the one it issued.
    expect(JSON.stringify(aFile)).not.toContain(bFile.peers[0].outboundSecret);
    expect(JSON.stringify(bFile)).not.toContain(aFile.peers[0].outboundSecret);
    values.secretsHashedOnBothSides = true;

    // B unpairs: B forgets A at once, and A, told by B, forgets B.
    await b.page.getByRole('button', { name: 'unpair Mac', exact: true }).click();
    await expect(b.page.getByText('Mac', { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await expect(a.page.getByText('PC', { exact: true })).toHaveCount(0, { timeout: 30_000 });
    values.aPeersAfter = machinesFile(a.home).peers.length;
    values.bPeersAfter = machinesFile(b.home).peers.length;
    expect(values.aPeersAfter).toBe(0);
    expect(values.bPeersAfter).toBe(0);
    await stepShot(a.page, '06-a-after-b-unpaired');
  } finally {
    recordValues(values);
    await a.app.close();
    await b.app.close();
  }
});
