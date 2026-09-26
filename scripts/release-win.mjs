#!/usr/bin/env node
/**
 * `npm run release:win`: the Windows build of the fork, and with `--publish`
 * its release on the fork's GitHub.
 *
 *   npm run release:win                        dry run: build and check, publish nothing
 *   npm run release:win -- --n 3               the same, as <version>-win.3
 *   npm run release:win -- --publish           build, check, then release on the fork
 *
 * The version (decision D11) is package.json's, which upstream owns and this
 * never edits, followed by `-win.<n>`: 1.9.0-win.1 is the first Windows build
 * of 1.9.0. n is `--n`, or one past the highest `v<version>-win.<n>` released
 * on the fork (`gh release list`, read only), and with neither a refusal. The
 * build is told it through electron-builder's `extraMetadata.version`, so the
 * app, the installer's name and latest.yml all say it.
 *
 * The feed is `build.win.publish` of package.json, the fork, which is also what
 * electron-builder bakes into resources/app-update.yml. macOS keeps
 * `build.publish` (the upstream) and its own `npm run release`, untouched.
 *
 * In this order, stopping at the first thing that is not as it should be:
 *   1. with --publish only: HEAD is origin/windows after a fetch, the tracked
 *      tree is clean, the electron installed is the one locked; then the
 *      version: n, and with --publish that v<version> is neither released nor
 *      tagged on the fork and nothing newer is released there;
 *   2. the build, what `npm run electron:build` does for macOS, for Windows:
 *      the app icon (scripts/make-app-ico.mjs), `npm run build:renderer`, the
 *      main process, the MCP bundles package.json ships (npm install and npm run
 *      build in each), then electron-builder --win --x64 with the stamp and
 *      build/electron-builder-win.json (package.json build, leaving out of
 *      node_modules what the app never loads), never publishing by itself (no
 *      CI, GH_TOKEN, GITHUB_TOKEN; --publish never);
 *   3. the artifacts: latest.yml names this version and the installer with its
 *      size and sha512, the blockmap and the zip exist, the app says this
 *      version, its app-update.yml feeds from the fork, and what the packaged
 *      app runs from disk is unpacked (node-pty with ConPTY, better-sqlite3,
 *      the Node hooks runner, every MCP bundle), and nothing it never loads is
 *      shipped (next, @next/swc, sharp, other platforms' prebuilds);
 *   4. the notes, from the changelog entry of the version;
 *   5. with --publish: gh release create v<version> on the fork, on the commit
 *      built, with the installer, its blockmap, the zip and latest.yml, as the
 *      latest release; then 6. what GitHub serves is read back.
 * Without --publish, 5 and 6 are only said.
 *
 * Tested in __tests__/scripts/release-win.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';
import { run, sha256Of } from './prune-releases.mjs';
import { changelogTop, checkElectron, parseLatestMac, Refusal } from './release.mjs';

/** The branch a Windows release is cut from (decision D13). */
export const RELEASE_BRANCH = 'windows';
const ARCH = 'x64';
/** What the packaged app runs with node from app.asar.unpacked/hooks (decision D1). */
const NODE_HOOKS = ['tars-hook.mjs', 'tars-hook-lib.mjs', 'statusline.mjs'];
const firstLine = text => text.trim().split('\n')[0] ?? '';

/** `<base>-win.<n>`. */
export function windowsVersion(base, n) {
  if (!/^\d+\.\d+\.\d+$/.test(String(base))) throw new Refusal(`package.json's version "${base}" is not x.y.z`);
  if (!Number.isInteger(n) || n < 1) throw new Refusal(`the Windows build number must be a whole number from 1, not ${n}`);
  return `${base}-win.${n}`;
}

/** One past the highest `v<base>-win.<n>` among these tags, 1 when there is none. */
export function nextBuildNumber(base, tags) {
  const own = new RegExp(`^v${base.replace(/\./g, '\\.')}-win\\.(\\d+)$`);
  return Math.max(0, ...tags.map(t => own.exec(String(t))?.[1]).filter(Boolean).map(Number)) + 1;
}

/** `x.y.z-win.n` of a tag, as numbers, or null. */
function parseWindowsTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)-win\.(\d+)$/.exec(String(tag));
  return m ? m.slice(1).map(Number) : null;
}

/** Positive when a is newer than b. */
function compareWindows(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function parseArgs(argv) {
  const options = { n: undefined, publish: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--publish') options.publish = true;
    else if (argv[i] === '--n') {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Refusal(`--n takes the build number, a whole number from 1, not ${value ?? 'nothing'}`);
      options.n = Number(value);
    } else throw new Refusal(`unknown argument ${argv[i]}: release:win takes --n <n> and --publish`);
  }
  return options;
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

/** `owner/repo` of `build.win.publish`: the fork, where Windows builds are released and fed from. */
export function windowsPublishRepo(root) {
  const pkg = readPackage(root);
  const publish = [pkg.build?.win?.publish].flat().find(p => p?.provider === 'github');
  if (!publish?.owner || !publish?.repo) throw new Refusal(`no GitHub owner and repo in build.win.publish of ${join(root, 'package.json')}`);
  return `${publish.owner}/${publish.repo}`;
}

/** The files electron-builder names from package.json's patterns. */
export function artifactNames(pkg, version) {
  const expand = (pattern, ext) => pattern.replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, ARCH).replace(/\$\{ext\}/g, ext);
  const setup = expand(pkg.build.nsis.artifactName, 'exe');
  return { setup, blockmap: `${setup}.blockmap`, zip: expand(pkg.build.win.artifactName, 'zip') };
}

/**
 * electron-builder's arguments. The stamp is extraMetadata, so package.json is
 * not edited. npmRebuild off: node-pty and better-sqlite3 ship N-API prebuilds
 * for win32-x64 that Electron loads as they are, so nothing is compiled and
 * node_modules is left as npm ci made it.
 */
export function builderArgs(version, configFile) {
  return ['--config', configFile, '--win', '--x64', '--publish', 'never', `-c.extraMetadata.version=${version}`, '-c.npmRebuild=false'];
}

/**
 * What a Windows build leaves out of node_modules, as electron-builder file
 * patterns: what NEVER_LOADED refuses. The `/**` matters: electron-builder 26
 * filters the files of a module, not its folder, so `!node_modules/@next/swc*`
 * (package.json build.files) leaves every file of @next/swc-* in.
 */
export const WINDOWS_EXCLUDED_FILES = [
  '!node_modules/next/**',
  '!node_modules/@next/**',
  '!node_modules/sharp/**',
  '!node_modules/@img/**',
  '!node_modules/better-sqlite3/deps/**',
  '!node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*',
  '!node_modules/node-pty/prebuilds/darwin-*/**',
];

/** Where the Windows config is written, beside the icon in the ignored build/. */
export const WINDOWS_CONFIG_FILE = join('build', 'electron-builder-win.json');

/**
 * package.json build, as it is, with WINDOWS_EXCLUDED_FILES added to its
 * files. Not build.win.files: electron-builder turns a platform's own files
 * into a matcher of its own, and one holding only exclusions matches
 * everything (measured: .next/cache, design/ and slide-deck/ were packed).
 * Added to build.files here, they join the same matcher. macOS never reads
 * this file: its build and package.json are untouched.
 */
export function windowsBuilderConfig(pkg) {
  return { ...pkg.build, files: [...(pkg.build.files ?? []), ...WINDOWS_EXCLUDED_FILES] };
}

/** The MCP folders package.json ships, from build.extraResources. */
function mcpDirs(pkg) {
  return (pkg.build?.extraResources ?? []).map(e => e.from).filter(from => /^mcp-/.test(from));
}

/** What `npm run electron:build` does for macOS, for Windows: each step a command and its argv, never a shell string. */
export function buildSteps(root, version) {
  const pkg = readPackage(root);
  const resolve = id => {
    try {
      return createRequire(join(root, 'package.json')).resolve(id);
    } catch {
      return join(root, 'node_modules', ...id.split('/'));
    }
  };
  const npm = (args, cwd, label) => ({ label, cwd, ...npmCommand('npm', args) });
  return [
    { label: 'app icon: node scripts/make-app-ico.mjs', cwd: root, command: process.execPath, args: [join(root, 'scripts', 'make-app-ico.mjs')] },
    npm(['run', 'build:renderer'], root, 'npm run build:renderer'),
    { label: 'tsc -p electron/tsconfig.json', cwd: root, command: process.execPath, args: [resolve('typescript/bin/tsc'), '-p', join('electron', 'tsconfig.json')] },
    ...mcpDirs(pkg).flatMap(mcp => [
      npm(['install'], join(root, mcp), `${mcp}: npm install`),
      npm(['run', 'build'], join(root, mcp), `${mcp}: npm run build`),
    ]),
    { label: `electron-builder ${builderArgs(version, WINDOWS_CONFIG_FILE).join(' ')}`, cwd: root, command: process.execPath, args: [resolve('electron-builder/cli.js'), ...builderArgs(version, join(root, WINDOWS_CONFIG_FILE))] },
  ];
}

/** The environment of the build: electron-builder publishes by itself when it finds CI or a token. */
export function buildEnv(env) {
  const out = { ...env };
  for (const key of ['CI', 'GH_TOKEN', 'GITHUB_TOKEN']) delete out[key];
  return out;
}

/** Runs the steps in order, and stops at the first that fails. */
export async function runSteps(steps, { env, log = console.log }) {
  for (const step of steps) {
    log(`   ${step.label}`);
    const r = spawnSync(step.command, step.args, { cwd: step.cwd, env, stdio: 'inherit' });
    if (r.error) throw new Refusal(`${step.label} could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Refusal(`${step.label} failed (exit ${r.status ?? r.signal})`);
  }
}

/**
 * What the packaged app never loads, and build.win.files leaves out of a
 * Windows build: the renderer is the static export in out/, so next and its
 * SWC compiler (about 280 MB) and sharp (next's optional image optimizer) are
 * build tools; of the native modules only the win32 prebuilds load, and
 * better-sqlite3's deps/ is sqlite's C source. electron/dist, the hooks and
 * the MCP bundles require none of them. A path under node_modules/ matching
 * one of these fails the release.
 */
export const NEVER_LOADED = [
  /^node_modules\/next\//,
  /^node_modules\/@next\//,
  /^node_modules\/sharp\//,
  /^node_modules\/@img\//,
  /^node_modules\/better-sqlite3\/deps\//,
  /^node_modules\/better-sqlite3\/prebuilds\/(?!win32-)/,
  /^node_modules\/node-pty\/prebuilds\/darwin-/,
];

function asarHeader(fd, asar) {
  const read = (length, position) => {
    const buf = Buffer.alloc(length);
    if (readSync(fd, buf, 0, length, position) !== length) throw new Refusal(`${asar} is shorter than its header says`);
    return buf;
  };
  const sizes = read(16, 0);
  return { read, headerSize: sizes.readUInt32LE(4), header: JSON.parse(read(sizes.readUInt32LE(12), 16).toString('utf8')) };
}

/** One file out of an asar archive, read from its header without the rest. */
export function readAsarFile(asar, name) {
  const fd = openSync(asar, 'r');
  try {
    const { read, headerSize, header } = asarHeader(fd, asar);
    let node = header;
    for (const part of name.split('/')) node = node?.files?.[part];
    if (!node || node.offset === undefined) throw new Refusal(`${asar} holds no ${name}`);
    return read(node.size, 8 + headerSize + Number(node.offset));
  } finally {
    closeSync(fd);
  }
}

/** Every file an asar archive lists, as `a/b/c` paths (the unpacked ones included). */
export function listAsar(asar) {
  const fd = openSync(asar, 'r');
  try {
    const found = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (child.files) walk(child, `${prefix}${name}/`);
        else found.push(`${prefix}${name}`);
      }
    };
    walk(asarHeader(fd, asar).header, '');
    return found;
  } finally {
    closeSync(fd);
  }
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath ?? e.path, e.name));
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** Step 3. Returns the files a release carries. */
export async function verifyWindowsArtifacts(releaseDir, version, { repo, pkg }) {
  const names = artifactNames(pkg, version);
  const yml = join(releaseDir, 'latest.yml');
  if (!existsSync(yml)) throw new Refusal(`${yml} does not exist`);
  const manifest = parseLatestMac(readFileSync(yml, 'utf8'));
  if (manifest.version !== version) throw new Refusal(`latest.yml is for ${manifest.version}, not ${version}`);
  const entry = manifest.files.length === 1 ? manifest.files[0] : undefined;
  if (entry?.url !== names.setup) throw new Refusal(`latest.yml does not name exactly ${names.setup}`);
  const setup = join(releaseDir, names.setup);
  if (!existsSync(setup)) throw new Refusal(`${setup} is named in latest.yml and does not exist`);
  const { size } = statSync(setup);
  if (Number(entry.size) !== size) throw new Refusal(`latest.yml gives ${names.setup} ${entry.size} bytes, the file has ${size}`);
  if (entry.sha512 !== sha512Base64(setup)) throw new Refusal(`the sha512 in latest.yml is not that of ${names.setup}`);
  if (manifest.path !== names.setup || manifest.sha512 !== entry.sha512) {
    throw new Refusal('the top-level path and sha512 of latest.yml are not those of the installer');
  }
  const blockmap = join(releaseDir, names.blockmap);
  if (!existsSync(blockmap)) throw new Refusal(`${names.blockmap} does not exist: the update would be downloaded whole every time`);
  const zip = join(releaseDir, names.zip);
  if (!existsSync(zip)) throw new Refusal(`${zip} does not exist`);

  const app = join(releaseDir, 'win-unpacked');
  const resources = join(app, 'resources');
  const exe = join(app, `${pkg.build.productName}.exe`);
  if (!existsSync(exe)) throw new Refusal(`${exe} does not exist`);

  const feed = existsSync(join(resources, 'app-update.yml'))
    ? Object.fromEntries(readFileSync(join(resources, 'app-update.yml'), 'utf8').split('\n')
      .map(line => /^(\w+):\s*(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]))
    : {};
  if (feed.provider !== 'github' || `${feed.owner}/${feed.repo}` !== repo) {
    throw new Refusal(`resources/app-update.yml feeds ${feed.provider ?? 'nothing'} ${feed.owner}/${feed.repo}, not github ${repo}`);
  }

  const shown = JSON.parse(readAsarFile(join(resources, 'app.asar'), 'package.json').toString('utf8')).version;
  if (shown !== version) throw new Refusal(`the built app says ${shown}, not ${version}`);

  const unpacked = join(resources, 'app.asar.unpacked');
  const shipped = [
    ...listAsar(join(resources, 'app.asar')),
    ...filesUnder(unpacked).map(f => relative(unpacked, f).split(sep).join('/')),
  ];
  for (const pattern of NEVER_LOADED) {
    const hit = shipped.find(f => pattern.test(f));
    if (hit) throw new Refusal(`the app ships ${hit}, which it never loads: build.win.files should leave it out`);
  }
  const pty =filesUnder(join(unpacked, 'node_modules', 'node-pty'));
  const withConpty = pty.filter(f => basename(f) === 'conpty.node').map(dirname)
    .some(dir => ['conpty.dll', 'OpenConsole.exe'].every(n => pty.includes(join(dir, 'conpty', n))));
  if (!withConpty) throw new Refusal('node-pty in app.asar.unpacked has no conpty.node beside conpty\\conpty.dll and conpty\\OpenConsole.exe');
  const sqlite = filesUnder(join(unpacked, 'node_modules', 'better-sqlite3'));
  if (!sqlite.some(f => [`win32-${ARCH}.node`, 'better_sqlite3.node'].includes(basename(f)))) {
    throw new Refusal('better-sqlite3 in app.asar.unpacked has no Windows binary');
  }
  for (const hook of NODE_HOOKS) {
    if (!existsSync(join(unpacked, 'hooks', hook))) throw new Refusal(`hooks/${hook} is not in app.asar.unpacked: the Node hooks cannot run`);
  }
  for (const e of pkg.build.extraResources ?? []) {
    if (!(e.filter ?? []).includes('dist/bundle.js')) continue;
    if (!existsSync(join(resources, e.to, 'dist', 'bundle.js'))) throw new Refusal(`resources/${e.to}/dist/bundle.js is missing: that MCP server cannot start`);
  }
  return { setup, blockmap, zip, yml };
}

/** Step 4. As the macOS notes, with the Windows footer (decision D12: not signed). */
export function composeWindowsNotes(top, base, version) {
  const updates = top.version === base ? top.updates.map(u => `- ${u}`).join('\n') : `- Tars ${base}`;
  const notes = `## Ce qui change\n\n${updates}\n\n---\n\nBuild Windows ${version} de Tars ${base}. L'installeur n'est pas signe: `
    + 'Windows SmartScreen affichera un avertissement au premier lancement.\n';
  if (/[–—]/.test(notes)) throw new Refusal(`the ${top.version} changelog entry has a long dash: rewrite the sentence`);
  return notes;
}

async function git(root, args) {
  const r = await run('git', args, { cwd: root });
  if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${firstLine(r.stderr)}`);
  return r.stdout;
}

async function ghJson(args) {
  const r = await run('gh', args);
  if (r.missing) throw new Refusal('gh is not installed');
  if (r.code !== 0) throw new Refusal(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`gh ${args.slice(0, 2).join(' ')} did not answer with JSON`);
  }
}

async function releasedTags(repo) {
  const listed = await ghJson(['release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName']);
  return listed.map(r => String(r?.tagName));
}

/** Step 1 of --publish, before anything else. */
async function checkPublishPreconditions(root) {
  const fetched = await run('git', ['fetch', 'origin'], { cwd: root });
  if (fetched.code !== 0) throw new Refusal(`git fetch origin failed: ${firstLine(fetched.stderr)}`);
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(root, ['rev-parse', `origin/${RELEASE_BRANCH}`])).trim();
  if (head !== branch) {
    throw new Refusal(`HEAD ${head.slice(0, 7)} is not origin/${RELEASE_BRANCH} ${branch.slice(0, 7)}: a Windows release is built from what ${RELEASE_BRANCH} holds, nothing else`);
  }
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty) throw new Refusal(`tracked files differ from HEAD, so the build would not be the commit:\n${dirty}`);
  const electron = checkElectron(root);
  return { head, electron };
}

/** Step 1, for a version about to be published. */
async function checkUnpublished(repo, version, tags) {
  if (tags.includes(`v${version}`)) throw new Refusal(`v${version} is already published on ${repo}`);
  const tag = await run('gh', ['api', `repos/${repo}/git/ref/tags/v${version}`]);
  if (tag.code === 0) throw new Refusal(`the tag v${version} already exists on ${repo}, without a release`);
  if (!/HTTP 404/.test(tag.stderr)) throw new Refusal(`could not check whether the tag v${version} exists on ${repo}: ${firstLine(tag.stderr)}`);
  const mine = parseWindowsTag(version);
  const newer = tags.filter(t => parseWindowsTag(t) && compareWindows(parseWindowsTag(t), mine) > 0)
    .sort((a, b) => compareWindows(parseWindowsTag(b), parseWindowsTag(a)));
  if (newer.length) throw new Refusal(`a newer version is already published on ${repo}: ${newer[0]}`);
}

/** Step 6. What GitHub serves, against what was built. */
async function readBack({ repo, version, head, files, yml }) {
  const ref = await ghJson(['api', `repos/${repo}/git/ref/tags/v${version}`]);
  let target = ref.object?.sha;
  if (ref.object?.type === 'tag') target = (await ghJson(['api', `repos/${repo}/git/tags/${target}`])).object?.sha;
  if (target !== head) throw new Refusal(`v${version} points at ${target}, not at the commit built ${head}`);
  for (const file of files) {
    const local = `sha256:${await sha256Of(file)}`;
    let digest;
    for (let attempt = 0; attempt < 5 && !digest; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 2000));
      const { assets } = await ghJson(['release', 'view', `v${version}`, '--repo', repo, '--json', 'assets']);
      digest = assets?.find(a => a.name === basename(file))?.digest;
    }
    if (digest !== local) throw new Refusal(`GitHub serves ${basename(file)} with ${digest ?? 'no digest'}, the local file is ${local}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tars-release-win-served-'));
  try {
    const got = await run('gh', ['release', 'download', `v${version}`, '--repo', repo, '--pattern', 'latest.yml', '--dir', dir]);
    if (got.code !== 0 || !readFileSync(join(dir, 'latest.yml')).equals(readFileSync(yml))) {
      throw new Refusal('the latest.yml GitHub serves is not the one checked');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== `v${version}`) throw new Refusal(`/releases/latest is ${latest.tag_name}, not v${version}`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), log = console.log, build = runSteps } = {}) {
  try {
    const options = parseArgs(argv);
    const toplevel = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (toplevel.code !== 0) throw new Refusal(`${cwd} is not inside a git checkout`);
    const root = toplevel.stdout.trim();
    // The checkout first: what package.json says only counts once it is the commit.
    const checked = options.publish ? await checkPublishPreconditions(root) : undefined;
    const head = checked?.head;
    const pkg = readPackage(root);
    const base = pkg.version;
    const repo = windowsPublishRepo(root);
    log(`release:win: Tars ${base} for Windows, released on ${repo}, from ${root}${options.publish ? '' : ', dry run: nothing is published'}`);
    if (checked) log(`1. HEAD ${head.slice(0, 7)} is origin/${RELEASE_BRANCH}, tracked tree clean, electron ${checked.electron} installed as locked`);

    let tags;
    if (options.publish || options.n === undefined) {
      try {
        tags = await releasedTags(repo);
      } catch (err) {
        if (!(err instanceof Refusal) || options.publish) throw err;
        throw new Refusal(`cannot read the releases of ${repo} to number this build (${err.message}): pass --n <n>`);
      }
    }
    const n = options.n ?? nextBuildNumber(base, tags);
    const version = windowsVersion(base, n);
    if (options.publish) await checkUnpublished(repo, version, tags);
    log(`1. version ${version}${options.n === undefined ? `: build ${n} of ${base} on ${repo}` : ''}${options.publish ? `, not yet on ${repo}, nothing newer there` : ''}`);

    log(`2. build ${version}, without CI, GH_TOKEN or GITHUB_TOKEN:`);
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, WINDOWS_CONFIG_FILE), `${JSON.stringify(windowsBuilderConfig(pkg), null, 2)}\n`);
    await build(buildSteps(root, version), { root, env: buildEnv(process.env), log });

    const releaseDir = join(root, 'release');
    const artifacts = await verifyWindowsArtifacts(releaseDir, version, { repo, pkg });
    log(`3. artifacts checked: ${basename(artifacts.setup)} and latest.yml agree, blockmap and zip present, the app says ${version}, feeds from ${repo}, and its native modules, Node hooks and MCP bundles are unpacked`);

    const notes = composeWindowsNotes(changelogTop(root), base, version);
    log(`4. notes:\n${notes}`);

    const files = [artifacts.setup, artifacts.blockmap, artifacts.zip, artifacts.yml];
    const create = ['release', 'create', `v${version}`, ...files, '--repo', repo, '--target', head ?? '<HEAD>',
      '--title', `Tars ${version}`, '--latest', '--notes-file'];
    if (!options.publish) {
      log(`5. would run gh ${create.join(' ')} <notes>, with --publish`);
      log(`6. would check that v${version} points at the commit built, that each asset's digest is the local file's, that the served latest.yml is this one, and that /releases/latest is v${version}`);
      log(`   installer: ${artifacts.setup}`);
      return 0;
    }

    const notesDir = mkdtempSync(join(tmpdir(), 'tars-release-win-notes-'));
    const notesFile = join(notesDir, 'notes.md');
    writeFileSync(notesFile, notes);
    const created = await run('gh', [...create, notesFile]);
    rmSync(notesDir, { recursive: true, force: true });
    if (created.code !== 0) throw new Refusal(`gh release create failed: ${firstLine(created.stderr)}`);
    log(`5. published v${version}`);

    await readBack({ repo, version, head, files, yml: artifacts.yml });
    log('6. GitHub serves exactly what was built');
    log(`   https://github.com/${repo}/releases/tag/v${version}`);
    return 0;
  } catch (err) {
    if (err instanceof Refusal) {
      log(`release:win: stopped. ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(code => process.exit(code));
}
