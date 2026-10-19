import { test, expect, _electron as electron } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { recordValues, removeHome } from './fixture.mjs';
import { apiPort } from './ports.mjs';

/**
 * A test build never passes for the maintainer's Tars (the plan's point 13, 19/10). On 18/10 two Uncaught
 * Exception boxes from the QA's copy, a Tars like any other in the Dock, looked like his own Tars looping.
 * `npm run electron:pack` (the build scripts/sandbox.sh starts, never a release's) is "Tars Sandbox":
 *
 * 1. the bundle: named "Tars Sandbox", its own bundle id (macOS keeps its settings, its notifications and its
 *    Application Support folder apart from Tars's), and its own icon, build/sandbox-icon.icns, not Tars's;
 * 2. launched, it calls itself "Tars Sandbox", and its menu bar item's menu says so ("Quit Tars Sandbox").
 *
 * Needs the packed app: TARS_PACKED_APP=<path to the .app> (npm run electron:pack writes
 * release/mac-arm64/Tars Sandbox.app). Skipped without it, as a live spec is. macOS only: electron:pack is --mac.
 * Red on main (e2363ae0), whose electron:pack builds release/mac-arm64/Tars.app: Tars's name, id and icon.
 * The artefact: values.json (the bundle's Info.plist as read, the icon's digest, the names read in the app).
 */

const APP = process.env.TARS_PACKED_APP;
const sha = (file: string) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

test.skip(!APP || process.platform !== 'darwin', 'TARS_PACKED_APP names the app npm run electron:pack built (macOS)');

test('a test build is Tars Sandbox: its name, its bundle id, its icon, and what it calls itself', async () => {
  test.setTimeout(120_000);
  const app = APP!;
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as Record<string, string>;
  const iconName = info.CFBundleIconFile.endsWith('.icns') ? info.CFBundleIconFile : `${info.CFBundleIconFile}.icns`;
  const icon = sha(path.join(app, 'Contents', 'Resources', iconName));
  const values: Record<string, unknown> = {
    app, bundle: { CFBundleName: info.CFBundleName, CFBundleDisplayName: info.CFBundleDisplayName, CFBundleIdentifier: info.CFBundleIdentifier, CFBundleExecutable: info.CFBundleExecutable, CFBundleIconFile: info.CFBundleIconFile },
    icon, sandboxIcon: sha(path.resolve('build', 'sandbox-icon.icns')), tarsIcon: sha(path.resolve('public', 'icon.icns')),
  };
  recordValues(values);

  // 1. The bundle.
  expect.soft(info.CFBundleName).toBe('Tars Sandbox');
  expect.soft(info.CFBundleIdentifier).toBe('xyz.cooperlabs.tars.sandbox');
  expect.soft(values.sandboxIcon, 'build/sandbox-icon.icns').not.toBeNull();
  expect.soft(icon, 'its icon is the sandbox\'s').toBe(values.sandboxIcon);
  expect.soft(icon, 'its icon is not Tars\'s').not.toBe(values.tarsIcon);

  // 2. Launched, on a sandbox HOME and profile, as scripts/sandbox.sh starts it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-packed-'));
  const launched = await electron.launch({
    executablePath: path.join(app, 'Contents', 'MacOS', info.CFBundleExecutable),
    args: [`--user-data-dir=${path.join(home, 'electron-profile')}`],
    env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home, DOROTHY_API_PORT: apiPort(31388), DOROTHY_E2E: '1' },
  });
  try {
    const seen = await launched.evaluate(({ app }) => {
      const req = process.mainModule!.require;
      const { join, dirname } = req('path') as typeof import('path');
      const tray = req(join(dirname(process.mainModule!.filename), 'core', 'tray-manager.js'));
      return { name: app.getName(), trayMenu: tray.trayContextMenu().items.map((i: { label: string }) => i.label) as string[] };
    });
    Object.assign(values, { seen });
    recordValues(values);
    expect.soft(seen.name).toBe('Tars Sandbox');
    expect.soft(seen.trayMenu).toContain('Quit Tars Sandbox');
  } finally {
    await launched.close().catch(() => undefined);
    await removeHome(home);
  }
});
