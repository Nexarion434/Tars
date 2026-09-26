import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fakeGh, sha256, type FakeGh } from './fake-gh';
import {
  artifactNames, buildEnv, builderArgs, buildSteps, main, NEVER_LOADED, nextBuildNumber, parseArgs, readAsarFile,
  verifyWindowsArtifacts, windowsBuilderConfig, windowsPublishRepo, windowsVersion,
} from '../../scripts/release-win.mjs';
import { Refusal } from '../../scripts/release.mjs';

/**
 * `npm run release:win`: the Windows build of the fork, stamped
 * `<package.json version>-win.<n>` (decision D11), fed from the fork's
 * releases, and published only with `--publish`.
 *
 * How it can fail, each case below:
 *  - the version: a malformed n or base accepted, n not the next one after the
 *    fork's releases of this base (another base's, a non-numeric tag, 10 vs 9),
 *    no n and no GitHub to ask it of treated as n = 1 instead of a refusal;
 *  - the stamp: package.json's version edited (upstream owns it), or the build
 *    not told the stamped version, so the app and latest.yml say 1.9.0;
 *  - the build: a step missing or out of order (the renderer, main, the seven
 *    MCP bundles, electron-builder last), an MCP bundle not built, the build
 *    left able to publish by itself (CI, GH_TOKEN, GITHUB_TOKEN), or --mac;
 *  - the artifacts: a latest.yml for another version, or whose size or sha512
 *    is not the installer's, no blockmap, a feed that is not the fork, a node-pty
 *    without its ConPTY binaries, a hook or an MCP bundle missing, an app that
 *    says another version, an app that ships what it never loads (next, the
 *    @next/swc compiler, sharp, another platform's native prebuilds, sqlite's
 *    sources), packed in the asar or beside it;
 *  - publishing: anything written to GitHub in a dry run, a publish from a
 *    commit that is not origin/windows, over an existing release or a tag left
 *    without one, below a newer one, or with other files than the installer, its blockmap, the zip and
 *    latest.yml.
 * No test runs electron-builder or reaches GitHub: the build is a function that
 * lays files out, and gh is the fake.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BASE = '1.9.0';
const FORK = 'Nexarion434/Tars';
const MCPS = REAL_PKG.build.extraResources.map((e: { from: string }) => e.from);

describe('the version it stamps', () => {
  it('is <base>-win.<n>', () => {
    expect(windowsVersion('1.9.0', 1)).toBe('1.9.0-win.1');
    expect(windowsVersion('1.10.2', 12)).toBe('1.10.2-win.12');
  });

  it('refuses an n that is not a whole number from 1, and a base that is not x.y.z', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => windowsVersion('1.9.0', n)).toThrow(Refusal);
    for (const base of ['1.9', '1.9.0-beta.1', 'v1.9.0', '']) expect(() => windowsVersion(base, 1)).toThrow(Refusal);
  });

  it('takes n one past the highest release of this base on the fork, numerically', () => {
    const tags = ['v1.9.0-win.1', 'v1.9.0-win.9', 'v1.9.0-win.10', 'v1.8.0-win.40', 'v1.9.0', 'v1.9.0-win.x', 'v1.9.0-beta.3'];
    expect(nextBuildNumber('1.9.0', tags)).toBe(11);
    expect(nextBuildNumber('1.9.1', tags)).toBe(1);
    expect(nextBuildNumber('1.9.0', [])).toBe(1);
  });

  it('reads --n and --publish, and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ n: undefined, publish: false });
    expect(parseArgs(['--n', '3'])).toEqual({ n: 3, publish: false });
    expect(parseArgs(['--publish'])).toEqual({ n: undefined, publish: true });
    expect(() => parseArgs(['--n'])).toThrow(Refusal);
    expect(() => parseArgs(['--n', 'two'])).toThrow(Refusal);
    expect(() => parseArgs(['--dry'])).toThrow(Refusal);
  });

  it('hands electron-builder the stamp and the Windows config, for Windows, never publishing by itself', () => {
    const args = builderArgs('1.9.0-win.3', 'C:\\repo\\build\\electron-builder-win.json');
    expect(args).toContain('--win');
    expect(args).not.toContain('--mac');
    expect(args.join(' ')).toContain('--publish never');
    expect(args).toContain('-c.extraMetadata.version=1.9.0-win.3');
    expect(args.join(' ')).toContain('--config C:\\repo\\build\\electron-builder-win.json');
  });
});

describe('the Windows build config', () => {
  // electron-builder's own matcher, the one it filters the app's files with.
  const { Minimatch } = createRequire(require.resolve('app-builder-lib'))('minimatch') as {
    Minimatch: new (pattern: string, options: object) => { match(path: string): boolean };
  };
  const excluded = (file: string, patterns: string[]) => patterns.filter(p => p.startsWith('!'))
    .some(p => new Minimatch(p.slice(1), { dot: true }).match(file));

  it('is package.json build as it is, files included, with only what the app never loads left out', () => {
    const before = JSON.stringify(REAL_PKG);
    const config = windowsBuilderConfig(REAL_PKG);
    expect(JSON.stringify(REAL_PKG)).toBe(before);
    const { files, ...rest } = config;
    const { files: ownFiles, ...ownRest } = REAL_PKG.build;
    expect(rest).toEqual(ownRest);
    expect(files.slice(0, ownFiles.length)).toEqual(ownFiles);
    expect(files.slice(ownFiles.length).every((p: string) => p.startsWith('!'))).toBe(true);
  });

  it('leaves out every path the artifact check refuses, and none the app loads', () => {
    const { files } = windowsBuilderConfig(REAL_PKG);
    for (const never of [
      'node_modules/next/dist/server/next.js', 'node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node',
      'node_modules/@next/env/dist/index.js', 'node_modules/sharp/lib/index.js', 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c', 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node', 'node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node',
      'node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    ]) {
      expect(NEVER_LOADED.some(p => p.test(never)), `${never} is not what the artifact check refuses`).toBe(true);
      expect(excluded(never, files), `${never} is packed`).toBe(true);
    }
    for (const kept of [
      'node_modules/better-sqlite3/prebuilds/win32-x64.node', 'node_modules/better-sqlite3/lib/index.js',
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 'node_modules/node-pty/lib/index.js',
      'node_modules/xterm-headless/package.json', 'node_modules/electron-updater/out/main.js', 'node_modules/nextjs-like/index.js',
    ]) {
      expect(excluded(kept, files), `${kept} is left out`).toBe(false);
      expect(NEVER_LOADED.some(p => p.test(kept)), `${kept} would be refused`).toBe(false);
    }
  });
});

describe('the build it runs', () => {
  it('icon, renderer, main, each MCP bundle, then electron-builder last', () => {
    const steps = buildSteps(ROOT, '1.9.0-win.1');
    const labels = steps.map(s => s.label);
    expect(labels[0]).toMatch(/icon/);
    expect(labels[1]).toMatch(/build:renderer/);
    expect(labels[2]).toMatch(/tsc/);
    expect(labels.at(-1)).toMatch(/electron-builder/);
    // The seven MCP bundles package.json ships, each installed then built in its own folder.
    expect(MCPS).toHaveLength(7);
    for (const mcp of MCPS) {
      const own = steps.filter(s => s.cwd === path.join(ROOT, mcp));
      expect(own.map(s => s.label)).toEqual([`${mcp}: npm install`, `${mcp}: npm run build`]);
    }
    expect(steps.at(-1)!.args).toEqual(expect.arrayContaining(builderArgs('1.9.0-win.1', path.join(ROOT, 'build', 'electron-builder-win.json'))));
    // No step is a shell string: every one is a command and its argv.
    for (const s of steps) expect(Array.isArray(s.args)).toBe(true);
  });

  it('runs without CI, GH_TOKEN or GITHUB_TOKEN, and keeps the rest', () => {
    const env = buildEnv({ CI: '1', GH_TOKEN: 't', GITHUB_TOKEN: 't', PATH: 'p', USERPROFILE: 'u' });
    expect(env).toEqual({ PATH: 'p', USERPROFILE: 'u' });
  });

  it('reads the feed from build.win.publish, the fork, never the upstream macOS feed', () => {
    expect(windowsPublishRepo(ROOT)).toBe(FORK);
    expect(REAL_PKG.build.publish.owner).not.toBe('Nexarion434');
  });

  it('names the installer and the zip from package.json', () => {
    expect(artifactNames(REAL_PKG, '1.9.0-win.2')).toEqual({
      setup: 'Tars-Setup-1.9.0-win.2.exe',
      blockmap: 'Tars-Setup-1.9.0-win.2.exe.blockmap',
      zip: 'Tars-Windows-1.9.0-win.2-x64.zip',
    });
  });
});

// ── A Windows build laid out as electron-builder does ─────────────────────

const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('base64');

/** An asar with these files, in the format @electron/asar writes. */
function writeAsar(file: string, files: Record<string, string>) {
  type Node = { files?: Record<string, Node>; size?: number; offset?: string };
  const header: Node = { files: {} };
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const parts = name.split('/');
    let dir = header;
    for (const part of parts.slice(0, -1)) dir = (dir.files![part] ??= { files: {} });
    dir.files![parts.at(-1)!] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  fs.writeFileSync(file, Buffer.concat([size, pickle, ...bodies]));
}

type Breakage = {
  ymlVersion?: string; wrongSha?: boolean; noBlockmap?: boolean; feedOwner?: string; noConpty?: boolean;
  noHook?: boolean; noMcp?: string; appVersion?: string;
  /** A file the app never loads, packed in the asar or unpacked beside it. */
  packed?: string; unpacked?: string;
};

function winBuild(releaseDir: string, version: string, broken: Breakage = {}) {
  const names = artifactNames(REAL_PKG, version);
  const setupBytes = `installer of ${version}`;
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, names.setup), setupBytes);
  if (!broken.noBlockmap) fs.writeFileSync(path.join(releaseDir, names.blockmap), 'blockmap');
  fs.writeFileSync(path.join(releaseDir, names.zip), `zip of ${version}`);
  fs.writeFileSync(path.join(releaseDir, 'builder-debug.yml'), 'x');
  const sha = broken.wrongSha ? sha512('other') : sha512(setupBytes);
  fs.writeFileSync(path.join(releaseDir, 'latest.yml'), [
    `version: ${broken.ymlVersion ?? version}`,
    'files:',
    `  - url: ${names.setup}`,
    `    sha512: ${sha}`,
    `    size: ${Buffer.byteLength(setupBytes)}`,
    `path: ${names.setup}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-09-26T10:00:00.000Z'",
    '',
  ].join('\n'));
  const app = path.join(releaseDir, 'win-unpacked');
  const res = path.join(app, 'resources');
  const unpacked = path.join(res, 'app.asar.unpacked');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(app, 'Tars.exe'), 'exe');
  fs.writeFileSync(path.join(res, 'app-update.yml'),
    `owner: ${broken.feedOwner ?? 'Nexarion434'}\nrepo: Tars\nprovider: github\nupdaterCacheDirName: tars-updater\n`);
  writeAsar(path.join(res, 'app.asar'), {
    'package.json': JSON.stringify({ name: 'tars', version: broken.appVersion ?? version }),
    'node_modules/xterm/package.json': '{}',
    ...(broken.packed ? { [broken.packed]: 'x' } : {}),
  });
  const put = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(unpacked, rel)), { recursive: true });
    fs.writeFileSync(path.join(unpacked, rel), 'x');
  };
  put('node_modules/node-pty/prebuilds/win32-x64/pty.node');
  put('node_modules/node-pty/prebuilds/win32-x64/conpty.node');
  if (!broken.noConpty) {
    put('node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll');
    put('node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe');
  }
  put('node_modules/better-sqlite3/prebuilds/win32-x64.node');
  if (broken.unpacked) put(broken.unpacked);
  for (const hook of ['tars-hook.mjs', 'tars-hook-lib.mjs', 'statusline.mjs']) {
    if (!(broken.noHook && hook === 'tars-hook.mjs')) put(`hooks/${hook}`);
  }
  for (const mcp of MCPS) {
    if (mcp === broken.noMcp) continue;
    fs.mkdirSync(path.join(res, mcp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(res, mcp, 'dist', 'bundle.js'), '//');
  }
}

describe('the artifacts it checks', () => {
  let dir: string;
  const V = '1.9.0-win.1';
  const verify = () => verifyWindowsArtifacts(dir, V, { repo: FORK, pkg: REAL_PKG });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-win-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a consistent build, so each refusal below is the check it names', async () => {
    winBuild(dir, V);
    const found = await verify();
    expect(path.basename(found.setup)).toBe('Tars-Setup-1.9.0-win.1.exe');
    expect(path.basename(found.yml)).toBe('latest.yml');
  });

  it.each<[string, Breakage, RegExp]>([
    ['a latest.yml for another version', { ymlVersion: '1.9.0' }, /latest\.yml is for 1\.9\.0/],
    ['a sha512 that is not the installer', { wrongSha: true }, /sha512/],
    ['no blockmap', { noBlockmap: true }, /blockmap/],
    ['a feed that is not the fork', { feedOwner: 'JeanBrasse' }, /app-update\.yml/],
    ['node-pty without its ConPTY binaries', { noConpty: true }, /conpty\.dll/],
    ['a hook missing', { noHook: true }, /tars-hook\.mjs/],
    ['an MCP bundle missing', { noMcp: 'mcp-kanban' }, /mcp-kanban/],
    ['an app that says another version', { appVersion: '1.9.0' }, /says 1\.9\.0/],
    ['next packed in the asar', { packed: 'node_modules/next/dist/server/next.js' }, /node_modules\/next\//],
    ['the @next/swc compiler unpacked', { unpacked: 'node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node' }, /node_modules\/@next\//],
    ['sharp\'s libvips unpacked', { unpacked: 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll' }, /node_modules\/@img\//],
    ['sharp itself packed', { packed: 'node_modules/sharp/lib/index.js' }, /node_modules\/sharp\//],
    ['a macOS better-sqlite3 prebuild', { unpacked: 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node' }, /darwin-arm64/],
    ['a Linux better-sqlite3 prebuild', { unpacked: 'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node' }, /linuxmusl-x64/],
    ['sqlite\'s sources', { unpacked: 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c' }, /better-sqlite3\/deps/],
    ['a macOS node-pty prebuild', { unpacked: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node' }, /darwin-arm64/],
  ])('refuses %s', async (_what, broken, message) => {
    winBuild(dir, V, broken);
    await expect(verify()).rejects.toThrow(message);
  });

  it('reads a file out of an asar', () => {
    const asar = path.join(dir, 'a.asar');
    writeAsar(asar, { 'a.txt': 'first', 'package.json': '{"version":"9"}' });
    expect(readAsarFile(asar, 'package.json').toString()).toBe('{"version":"9"}');
    expect(() => readAsarFile(asar, 'missing.json')).toThrow(/missing\.json/);
  });
});

// ── main(), in a checkout of its own ─────────────────────────────────────

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

/** A checkout of `windows` pushed to a local origin, with the real package.json's build config at version BASE. */
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-win-co-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'windows', origin);
  const dir = path.join(root, 'checkout');
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'windows');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tars', version: BASE, build: REAL_PKG.build, devDependencies: { electron: '^44.4.4' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'tars', version: BASE, lockfileVersion: 3,
    packages: { '': { name: 'tars', version: BASE }, 'node_modules/electron': { version: '44.4.4', dev: true } },
  }));
  const electron = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(path.join(electron, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '44.4.4' }));
  fs.writeFileSync(path.join(electron, 'dist', 'version'), '44.4.4');
  fs.writeFileSync(path.join(dir, 'src', 'data', 'changelog.ts'),
    `export const CHANGELOG = [{ id: 1, version: '${BASE}', date: '2026-09-26', updates: ['What changed in ${BASE}'] }];\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'release/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'windows');
  return { root, dir };
}

// Real git checkouts and a fake gh per case: well past vitest's 5 s default on a loaded machine.
describe('npm run release:win', { timeout: 60_000 }, () => {
  let gh: FakeGh;
  let roots: string[];
  let built: { version: string; env: Record<string, string | undefined> }[];

  /** The build: records what it was asked, and lays out a consistent build of that version. */
  const build = async (steps: { args: string[] }[], { root, env }: { root: string; env: Record<string, string | undefined> }) => {
    const stamp = steps.at(-1)!.args.find(a => a.startsWith('-c.extraMetadata.version='))!.split('=')[1];
    built.push({ version: stamp, env });
    winBuild(path.join(root, 'release'), stamp);
  };

  async function releaseWin(cwd: string, ...argv: string[]) {
    const lines: string[] = [];
    const code = await main(argv, { cwd, log: (line: string) => lines.push(line), build });
    return { code, out: lines.join('\n') };
  }

  const writes = () => gh.calls().filter(args => !['view', 'list', 'download'].includes(args[1]) && args[0] !== 'api');

  beforeEach(() => {
    gh = fakeGh({});
    gh.install();
    roots = [];
    built = [];
  });
  afterEach(() => {
    gh.uninstall();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  const co = () => {
    const made = checkout();
    roots.push(made.root);
    return made.dir;
  };

  it('dry run: builds 1.9.0-win.1 when the fork has no release, publishes nothing, leaves package.json alone', async () => {
    const dir = co();
    const before = fs.readFileSync(path.join(dir, 'package.json'));

    const { code, out } = await releaseWin(dir);

    expect(code).toBe(0);
    expect(built.map(b => b.version)).toEqual(['1.9.0-win.1']);
    expect(built[0].env).not.toHaveProperty('GH_TOKEN');
    expect(out).toContain('1.9.0-win.1');
    expect(out).toMatch(/would run gh release create v1\.9\.0-win\.1 .*Tars-Setup-1\.9\.0-win\.1\.exe/);
    expect(writes()).toEqual([]);
    // Only a read of the fork's releases.
    expect(gh.calls()).toEqual([['release', 'list', '--repo', FORK, '--limit', '1000', '--json', 'tagName']]);
    expect(fs.readFileSync(path.join(dir, 'package.json')).equals(before)).toBe(true);
    // The config electron-builder was pointed at, written beside the icon in the ignored build/.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'build', 'electron-builder-win.json'), 'utf8'))).toEqual(windowsBuilderConfig(JSON.parse(before.toString())));
  });

  it('dry run: takes the next n from the fork', async () => {
    gh.setState({ releases: { 'v1.9.0-win.1': { assets: [] }, 'v1.9.0-win.2': { assets: [] } } });
    const { code } = await releaseWin(co());
    expect(code).toBe(0);
    expect(built.map(b => b.version)).toEqual(['1.9.0-win.3']);
  });

  it('dry run: --n needs no GitHub', async () => {
    gh.setState({ offline: true });
    const { code } = await releaseWin(co(), '--n', '7');
    expect(code).toBe(0);
    expect(built.map(b => b.version)).toEqual(['1.9.0-win.7']);
    expect(gh.calls()).toEqual([]);
  });

  it('refuses to guess n when GitHub cannot be asked, before building', async () => {
    gh.setState({ offline: true });
    const { code, out } = await releaseWin(co());
    expect(code).toBe(1);
    expect(out).toMatch(/--n/);
    expect(built).toEqual([]);
  });

  it('--publish: releases the installer, its blockmap, the zip and latest.yml on the fork, on the commit built', async () => {
    const dir = co();
    gh.allowPublishing();

    const { code, out } = await releaseWin(dir, '--publish');

    expect(out).toContain('published');
    expect(code).toBe(0);
    const [create] = writes();
    expect(create.slice(0, 7)).toEqual(['release', 'create', 'v1.9.0-win.1',
      path.join(dir, 'release', 'Tars-Setup-1.9.0-win.1.exe'),
      path.join(dir, 'release', 'Tars-Setup-1.9.0-win.1.exe.blockmap'),
      path.join(dir, 'release', 'Tars-Windows-1.9.0-win.1-x64.zip'),
      path.join(dir, 'release', 'latest.yml')]);
    expect(create).toEqual(expect.arrayContaining(['--repo', FORK, '--latest']));
    const release = gh.state().releases!['v1.9.0-win.1'];
    expect(release.target).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(release.assets.find(a => a.name === 'latest.yml')!.digest)
      .toBe(sha256(fs.readFileSync(path.join(dir, 'release', 'latest.yml'))));
  });

  it('--publish: refuses a HEAD that is not origin/windows, before building', async () => {
    const dir = co();
    fs.writeFileSync(path.join(dir, 'README.md'), 'not pushed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local only');
    gh.allowPublishing();

    const { code, out } = await releaseWin(dir, '--publish');

    expect(code).toBe(1);
    expect(out).toContain('is not origin/windows');
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('--publish: refuses a tracked file that differs from HEAD', async () => {
    const dir = co();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const { code, out } = await releaseWin(dir, '--publish');
    expect(code).toBe(1);
    expect(out).toMatch(/tracked files differ/);
  });

  it('--publish: refuses a tag that exists with no release, before building', async () => {
    gh.setState({ tags: ['v1.9.0-win.1'] });
    gh.allowPublishing();
    const { code, out } = await releaseWin(co(), '--publish');
    expect(code).toBe(1);
    expect(out).toContain('the tag v1.9.0-win.1 already exists on Nexarion434/Tars, without a release');
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('--publish --n: refuses a version already released, and one below a newer release', async () => {
    gh.setState({ releases: { 'v1.9.0-win.4': { assets: [] } } });
    gh.allowPublishing();
    const taken = await releaseWin(co(), '--publish', '--n', '4');
    expect(taken.code).toBe(1);
    expect(taken.out).toMatch(/v1\.9\.0-win\.4 is already published/);

    const older = await releaseWin(co(), '--publish', '--n', '2');
    expect(older.code).toBe(1);
    expect(older.out).toMatch(/newer .*v1\.9\.0-win\.4/);
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
