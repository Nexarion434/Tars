import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  compareSemver, installerAssetFor, isNewerRelease, updateRepoFor, WINDOWS_UPDATE_REPO,
} from '../../../electron/platform/update-feed';

/**
 * Where a platform's updates come from, which asset of a release it installs,
 * and which release is newer (audit B, answer 4; decisions D11, D13): the
 * decisions behind the GitHub fallback of update-checker.ts, pure.
 *
 * How it can fail, each case below:
 *  - win32 reads the upstream, or darwin and linux the fork;
 *  - the fork named here and the one package.json build.win.publish feeds
 *    electron-updater from drift apart;
 *  - a .dmg, a .zip or a blockmap offered on win32, or the other
 *    architecture's installer, or a macOS file when there is no setup .exe;
 *  - darwin and linux no longer get the .dmg first, then the .zip;
 *  - an order that is not electron-updater's (semver 2.0 precedence): `-win.10`
 *    before `-win.9`, a prerelease equal to or above its release, a numeric
 *    identifier compared as text, a malformed tag read as a version;
 *  - darwin and linux no longer compare x.y.z the way they always did.
 */

const UPSTREAM = 'JeanBrasse/Tars';
const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });

describe('which repository feeds which platform', () => {
  it('win32: the fork; darwin and linux: the repository they are given, as before', () => {
    expect(updateRepoFor('win32', UPSTREAM)).toBe('Nexarion434/Tars');
    expect(updateRepoFor('darwin', UPSTREAM)).toBe(UPSTREAM);
    expect(updateRepoFor('linux', UPSTREAM)).toBe(UPSTREAM);
  });

  it('is the fork package.json build.win.publish feeds electron-updater from, and never the macOS feed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    expect(`${pkg.build.win.publish.owner}/${pkg.build.win.publish.repo}`).toBe(WINDOWS_UPDATE_REPO);
    expect(`${pkg.build.publish.owner}/${pkg.build.publish.repo}`).not.toBe(WINDOWS_UPDATE_REPO);
  });
});

describe('which asset is offered', () => {
  const release = [asset('Tars-1.9.0-arm64.dmg'), asset('Tars-1.9.0-arm64-mac.zip'), asset('latest-mac.yml'),
    asset('Tars-Setup-1.9.0-win.2.exe.blockmap'), asset('Tars-Setup-1.9.0-win.2.exe'), asset('Tars-Windows-1.9.0-win.2-x64.zip'), asset('latest.yml')];

  it('win32: the setup .exe, never the .dmg, the .zip or the blockmap', () => {
    expect(installerAssetFor(release, 'win32', 'x64')?.name).toBe('Tars-Setup-1.9.0-win.2.exe');
  });

  it('win32: nothing when the release has no setup .exe, rather than a macOS file', () => {
    expect(installerAssetFor(release.filter(a => !a.name.includes('Setup')), 'win32', 'x64')).toBeUndefined();
  });

  it('win32: this architecture\'s setup first, then any setup', () => {
    const both = [asset('Tars-Setup-2.0.0-win.1-arm64.exe'), asset('Tars-Setup-2.0.0-win.1-x64.exe')];
    expect(installerAssetFor(both, 'win32', 'x64')?.name).toBe('Tars-Setup-2.0.0-win.1-x64.exe');
    expect(installerAssetFor(both, 'win32', 'arm64')?.name).toBe('Tars-Setup-2.0.0-win.1-arm64.exe');
    expect(installerAssetFor([asset('tars-setup-2.0.0.EXE')], 'win32', 'x64')?.name).toBe('tars-setup-2.0.0.EXE');
  });

  it('darwin and linux: unchanged, the .dmg, then the .zip', () => {
    expect(installerAssetFor(release, 'darwin', 'arm64')?.name).toBe('Tars-1.9.0-arm64.dmg');
    expect(installerAssetFor([asset('Tars-1.9.0-arm64-mac.zip')], 'darwin', 'arm64')?.name).toBe('Tars-1.9.0-arm64-mac.zip');
    expect(installerAssetFor(release, 'linux', 'x64')?.name).toBe('Tars-1.9.0-arm64.dmg');
  });
});

describe('which release is newer', () => {
  it.each([
    ['1.9.0-win.9', '1.9.0-win.10', true],
    ['1.9.0-win.7', '1.9.1-win.1', true],
    ['1.9.0-win.1', '2.0.0-win.1', true],
    ['1.9.0-win.10', '1.10.0-win.1', true],
    // A release is above its own prereleases (semver 2.0, what electron-updater follows).
    ['1.9.0-win.3', '1.9.0', true],
    ['1.9.0', '1.9.0-win.1', false],
    ['1.9.0-win.2', '1.9.0-win.2', false],
    ['1.9.0-win.3', '1.9.0-win.2', false],
    ['1.9.0-win.1', '1.8.9-win.20', false],
    ['1.9.0-win.1', 'not-a-version', false],
  ])('win32: %s installed, %s released: an update is %s', (installed, latest, newer) => {
    expect(isNewerRelease(installed, latest, 'win32')).toBe(newer);
  });

  it('darwin and linux: x.y.z compared part by part, as before', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(isNewerRelease('1.2.1', '1.2.2', platform)).toBe(true);
      expect(isNewerRelease('1.2.9', '1.2.10', platform)).toBe(true);
      expect(isNewerRelease('1.2.1', '1.1.0', platform)).toBe(false);
      expect(isNewerRelease('1.2.1', '1.2.1', platform)).toBe(false);
    }
  });

  it('orders every pair as semver, the library electron-updater compares with, does', () => {
    const semver = createRequire(require.resolve('electron-updater'))('semver') as { compare(a: string, b: string): number };
    const versions = ['1.9.0', '1.9.0-win.1', '1.9.0-win.2', '1.9.0-win.10', '1.9.1-win.1', '1.10.0-win.1', '1.10.0',
      '2.0.0-alpha', '2.0.0-alpha.1', '2.0.0-alpha.beta', '2.0.0-beta', '2.0.0-beta.2', '2.0.0-beta.11', '2.0.0-rc.1', '2.0.0'];
    for (const a of versions) {
      for (const b of versions) {
        expect(Math.sign(compareSemver(a, b) ?? Number.NaN), `${a} vs ${b}`).toBe(semver.compare(a, b));
      }
    }
    expect(compareSemver('1.9', '1.9.0')).toBeNull();
    expect(compareSemver('1.9.0-', '1.9.0')).toBeNull();
  });
});
