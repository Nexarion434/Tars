import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The GitHub fallback of the update check on Windows (audit B, answer 4).
 *
 * electron-updater reads the feed electron-builder baked into the app
 * (build.win.publish, the fork). When it throws, update-checker.ts asks the
 * GitHub API itself, and until this port it asked the upstream repository,
 * compared versions as dot-separated numbers and offered the first .dmg: a
 * macOS installer to a Windows user.
 *
 * How it can fail, each case below:
 *  - the fallback asks the upstream on win32, or the fork anywhere else;
 *  - the fork named in the code and the one package.json feeds from drift apart;
 *  - a .dmg or a .zip is offered on win32, or the wrong architecture's installer;
 *  - `1.9.0-win.10` is read as older than `1.9.0-win.9`, or a Windows build of
 *    the next version as not newer, or an older one as newer;
 *  - macOS and Linux change: the upstream, the .dmg first, then the .zip.
 * The macOS cases of update-checker.test.ts run with the platform held at darwin.
 */

const { mockAutoUpdater, mockFetch, current } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    currentVersion: { version: '1.9.0-win.1' },
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
  mockFetch: vi.fn(),
  current: { version: '1.9.0-win.1' },
}));

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), app: { getVersion: () => current.version } }));
vi.mock('../../electron/constants', () => ({ GITHUB_REPO: 'JeanBrasse/Tars' }));
vi.stubGlobal('fetch', mockFetch);

import {
  checkForUpdates, installerAssetFor, setMainWindowGetter, updateRepoFor, WINDOWS_UPDATE_REPO,
} from '../../electron/services/update-checker';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }));
afterAll(() => Object.defineProperty(process, 'platform', platform));

const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });
const RELEASE_PAGE = 'https://github.com/Nexarion434/Tars/releases/tag/v1.9.0-win.2';

function makeWindow() {
  return { webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow & { webContents: { send: ReturnType<typeof vi.fn> } };
}

/** The fallback, run as checkForUpdates runs it: electron-updater throws, GitHub answers with `release`. */
async function fallback(release: { tag_name: string; assets?: { name: string; browser_download_url: string }[] }) {
  const win = makeWindow();
  setMainWindowGetter(() => win);
  mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Cannot find latest.yml'));
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ html_url: RELEASE_PAGE, body: 'notes', assets: [], ...release }) });
  const result = await checkForUpdates();
  const [channel, info] = win.webContents.send.mock.calls[0];
  return { result, channel, info, url: mockFetch.mock.calls[0][0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  current.version = '1.9.0-win.1';
});

describe('which repository feeds which platform', () => {
  it('Windows: the fork; macOS and Linux: GITHUB_REPO, as before', () => {
    expect(updateRepoFor('win32')).toBe('Nexarion434/Tars');
    expect(updateRepoFor('darwin')).toBe('JeanBrasse/Tars');
    expect(updateRepoFor('linux')).toBe('JeanBrasse/Tars');
  });

  it('is the fork package.json build.win.publish feeds electron-updater from, and never the macOS feed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(`${pkg.build.win.publish.owner}/${pkg.build.win.publish.repo}`).toBe(WINDOWS_UPDATE_REPO);
    expect(`${pkg.build.publish.owner}/${pkg.build.publish.repo}`).not.toBe(WINDOWS_UPDATE_REPO);
  });
});

describe('which asset is offered', () => {
  const release = [asset('Tars-1.9.0-arm64.dmg'), asset('Tars-1.9.0-arm64-mac.zip'), asset('latest-mac.yml'),
    asset('Tars-Setup-1.9.0-win.2.exe.blockmap'), asset('Tars-Setup-1.9.0-win.2.exe'), asset('Tars-Windows-1.9.0-win.2-x64.zip'), asset('latest.yml')];

  it('Windows: the setup .exe, never the .dmg, the .zip or the blockmap', () => {
    expect(installerAssetFor(release, 'win32', 'x64')?.name).toBe('Tars-Setup-1.9.0-win.2.exe');
  });

  it('Windows: nothing when the release has no setup .exe, rather than a macOS file', () => {
    expect(installerAssetFor(release.filter(a => !a.name.includes('Setup')), 'win32', 'x64')).toBeUndefined();
  });

  it('Windows: this architecture\'s setup first, then any setup', () => {
    const both = [asset('Tars-Setup-2.0.0-win.1-arm64.exe'), asset('Tars-Setup-2.0.0-win.1-x64.exe')];
    expect(installerAssetFor(both, 'win32', 'x64')?.name).toBe('Tars-Setup-2.0.0-win.1-x64.exe');
    expect(installerAssetFor(both, 'win32', 'arm64')?.name).toBe('Tars-Setup-2.0.0-win.1-arm64.exe');
    expect(installerAssetFor([asset('tars-setup-2.0.0.EXE')], 'win32', 'x64')?.name).toBe('tars-setup-2.0.0.EXE');
  });

  it('macOS and Linux: unchanged, the .dmg, then the .zip', () => {
    expect(installerAssetFor(release, 'darwin', 'arm64')?.name).toBe('Tars-1.9.0-arm64.dmg');
    expect(installerAssetFor([asset('Tars-1.9.0-arm64-mac.zip')], 'darwin', 'arm64')?.name).toBe('Tars-1.9.0-arm64-mac.zip');
    expect(installerAssetFor(release, 'linux', 'x64')?.name).toBe('Tars-1.9.0-arm64.dmg');
  });
});

describe('the fallback on Windows', () => {
  it('asks the fork, and offers the next Windows build\'s installer', async () => {
    const { result, channel, info, url } = await fallback({
      tag_name: 'v1.9.0-win.2',
      assets: [asset('Tars-1.9.0-arm64.dmg'), asset('Tars-Setup-1.9.0-win.2.exe')],
    });
    expect(url).toBe('https://api.github.com/repos/Nexarion434/Tars/releases/latest');
    expect(result).toEqual({ devMode: false, fallback: true });
    expect(channel).toBe('app:update-available');
    expect(info).toMatchObject({
      currentVersion: '1.9.0-win.1',
      latestVersion: '1.9.0-win.2',
      downloadUrl: 'https://example.com/Tars-Setup-1.9.0-win.2.exe',
      hasUpdate: true,
    });
  });

  it('offers the release page, never a .dmg, when the release has no setup .exe', async () => {
    const { info } = await fallback({ tag_name: 'v1.9.0-win.2', assets: [asset('Tars-1.9.0-arm64.dmg'), asset('Tars-1.9.0-arm64-mac.zip')] });
    expect(info.downloadUrl).toBe(RELEASE_PAGE);
  });

  it.each([
    ['1.9.0-win.9', 'v1.9.0-win.10', true],
    ['1.9.0-win.7', 'v1.9.1-win.1', true],
    ['1.9.0-win.1', 'v2.0.0-win.1', true],
    ['1.9.0-win.2', 'v1.9.0-win.2', false],
    ['1.9.0-win.3', 'v1.9.0-win.2', false],
    ['1.9.0-win.1', 'v1.8.9-win.20', false],
    ['1.9.0-win.1', 'not-a-version', false],
  ])('%s against %s: an update is %s', async (installed, tag, newer) => {
    current.version = installed;
    const { channel, info } = await fallback({ tag_name: tag, assets: [asset('Tars-Setup-x.exe')] });
    expect(info.hasUpdate ?? false).toBe(newer);
    expect(channel).toBe(newer ? 'app:update-available' : 'app:update-not-available');
  });
});
