import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The switch to the new interface (PLAN-2.0.0, its first PR): one setting,
 * `newInterface`, read and written by the app-settings channels the Settings
 * page already uses. Off unless chosen.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A settings file written before the switch existed has no such key, and
 *    the renderer reads `undefined`: a page that tests `=== false` takes the
 *    wrong branch, one that tests `!newInterface` hides the difference.
 * 2. Adding the default breaks the load of an older file: its own values are
 *    replaced by the defaults, or it fails to load at all.
 * 3. Saving the switch on does not reach the file, or reaches it and reads
 *    back off.
 *
 * Driven through the preload (`window.electronAPI.appSettings`), the very
 * path the Settings row will take.
 */

test('the new interface switch reads off from an older file, which still loads, and a save turns it on', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-new-interface-'));
  seedSandbox(home);

  // A 1.9.x settings file: no `newInterface`, and values that differ from the
  // defaults, so a load that drops them shows.
  const file = path.join(home, '.dorothy', 'app-settings.json');
  const older = {
    notificationsEnabled: false,
    autoStartAgentsOnLaunch: false,
    terminalFontSize: 17,
    defaultProvider: 'codex',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(older, null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31456), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);

    type Settings = Record<string, unknown>;
    const read = () => page.evaluate(() =>
      (window as unknown as { electronAPI: { appSettings: { get: () => Promise<Settings> } } }).electronAPI.appSettings.get());

    const first = await read();
    const olderBack = Object.fromEntries(Object.keys(older).map(k => [k, first[k]]));

    const saved = await page.evaluate(() =>
      (window as unknown as { electronAPI: { appSettings: { save: (s: Settings) => Promise<unknown> } } })
        .electronAPI.appSettings.save({ newInterface: true }));
    const second = await read();
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));

    recordValues({
      newInterfaceBefore: first.newInterface ?? '(absent)',
      olderFieldsBack: olderBack,
      saveAnswer: saved,
      newInterfaceAfter: second.newInterface,
      newInterfaceOnDisk: onDisk.newInterface,
      olderFieldsOnDiskAfterSave: Object.fromEntries(Object.keys(older).map(k => [k, onDisk[k]])),
    });

    // 1. Off, as a boolean, for a file that never had the key.
    expect(first.newInterface).toBe(false);
    // 2. The older file's own values come through untouched.
    expect(olderBack).toEqual(older);
    // 3. A save turns it on, in the app and in the file, and keeps the rest.
    expect(second.newInterface).toBe(true);
    expect(onDisk.newInterface).toBe(true);
    expect(Object.fromEntries(Object.keys(older).map(k => [k, onDisk[k]]))).toEqual(older);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
