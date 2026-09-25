import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/** The process listing, as the product runs it, unless a case takes it away (as the ACP tests take ps away). */
const listingBroken = { value: false };
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      if (listingBroken.value && /[\\/]powershell\.exe$/i.test(file)) {
        const done = rest.find(r => typeof r === 'function') as ((err: Error, out: string, errOut: string) => void) | undefined;
        setImmediate(() => done?.(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''));
        return {} as never;
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
  };
});

import { runCliUpdatePass, updateCli, startCliUpdates, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';

/**
 * Tars keeps claude and Amp up to date on Windows too (audit A28).
 *
 * Before this, every CLI was "skipped: not installed" there, silently: the
 * lookup asked for an executable bit and a name without PATHEXT, the native
 * installer was recognised by a link it does not make on Windows, npm's
 * global packages were looked for under lib/node_modules, the busy check ran
 * lsof, and npm was started by a bare name, which is npm.cmd there.
 *
 * The layouts below are the real ones, read on this machine and in the
 * installer itself:
 * - claude's native installer keeps each version as a file in
 *   %USERPROFILE%\.local\share\claude\versions (2.1.77 and 2.1.78 here) and
 *   copies the one it installs over %USERPROFILE%\.local\bin\claude.exe, the
 *   running one renamed aside to claude.exe.old.<time>. It takes a launcher
 *   whose size is a version's as being on that version: the win32 branch of
 *   its own installer, read out of the 2.1.78 binary.
 * - npm's global prefix is %APPDATA%\npm: packages in node_modules right
 *   under it, no lib, and the shims (amp.cmd, npm.cmd) beside them, no bin.
 *   A shim runs `node <script>` or a native .exe inside its package.
 *
 * Every fake is a real Windows program: a claude.exe that is this run's
 * node.exe under that name, told what to do by a script NODE_OPTIONS
 * preloads, and npm and amp as npm's own .cmd shims over node scripts. The
 * fakes record the argv they were handed. No real CLI, no network, nothing
 * outside a scratch folder.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. claude.exe in ~/.local/bin is not found: no executable bit on Windows, or
 *    no PATHEXT, and a CLI that is there is logged as not installed.
 * 2. The native install is not recognised because its launcher is a file, not
 *    a link, and its version is not read from the versions it is a copy of.
 * 3. `claude.exe update` is not run as one argument, or the verdict is taken
 *    from its words instead of what is on disk after it.
 * 4. An update is held back by, or breaks, a session running the old launcher.
 * 5. An update that changes nothing is called one, a failure is not logged
 *    with the line that explains it.
 * 6. A claude.exe in ~/.local/bin that is none of the installer's versions is
 *    updated as if it were.
 * 7. claude installed by npm (a native exe inside its package) is updated
 *    through a path nobody measured, instead of named and left.
 * 8. Amp's global package is not found under %APPDATA%\npm\node_modules, or
 *    its version is read from the wrong manifest.
 * 9. npm is started by a bare name (ENOENT: it is npm.cmd), or through a
 *    shell, rather than as the node and script its shim runs, with the
 *    arguments macOS gets.
 * 10. The busy check runs lsof, or misses a process running the package: a
 *    node.exe with its script on the command line.
 * 11. When the busy check cannot run, the update goes ahead instead of waiting.
 * 12. An install outside the home Tars runs in is touched.
 * 13. A Settings path that names something Windows cannot start is logged as
 *    not installed, instead of saying why.
 * 14. The schedule main.ts starts does not reach the native claude a launch
 *    on Windows would find.
 */

const onWindows = process.platform === 'win32';

vi.setConfig({ testTimeout: 60_000 });

/** Preloaded into the fake claude.exe (this run's node.exe), where it acts as claude 2.1.78's Windows installer does. */
const FAKE_CLAUDE = `
const fs = require('fs'), path = require('path');
if (path.basename(process.execPath).toLowerCase() === 'claude.exe' && process.argv[1]) {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['claude', ...args]) + '\\n');
  const launcher = process.execPath;
  const versions = path.join(process.env.USERPROFILE, '.local', 'share', 'claude', 'versions');
  const current = fs.readdirSync(versions).find(v => fs.statSync(path.join(versions, v)).size === fs.statSync(launcher).size);
  const mode = process.env.FAKE_CLAUDE_MODE || 'update';
  if (args[0] === 'update' && mode === 'update') {
    const next = process.env.FAKE_NEXT || '1.0.1';
    fs.copyFileSync(path.join(versions, current), path.join(versions, next));
    fs.appendFileSync(path.join(versions, next), Buffer.alloc(16 + next.length));
    const old = launcher + '.old.' + Date.now();
    fs.renameSync(launcher, old);
    fs.copyFileSync(path.join(versions, next), launcher);
    try { fs.unlinkSync(old); } catch { /* running, as claude leaves it */ }
    console.log('Current version: ' + current);
    console.log('Successfully updated from ' + current + ' to version ' + next);
  } else if (args[0] === 'update' && mode === 'current') {
    console.log('Claude Code is up to date (' + current + ')');
  } else if (args[0] === 'update' && mode === 'fail') {
    console.log('Current version: ' + current);
    console.error('Error: Failed to install native update');
    console.error('TelemetrySafeError: connect ECONNREFUSED 35.190.46.17:443');
    process.exit(1);
  }
  process.exit(0);
}
`;

/** npm's cli, faked: records its argv, answers `view` with FAKE_LATEST, rewrites the manifest a global install names. */
const FAKE_NPM = `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['npm', ...args]) + '\\n');
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); process.exit(0); }
if (args[0] === 'install' && args.includes('--global')) {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
process.exit(0);
`;

/** npm's cmd-shim over a node script, as npm 10 writes it (copied from %APPDATA%\npm\codex.cmd here). */
const CMD_SHIM_NODE = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');
/** The same over a native exe (%APPDATA%\npm\claude.cmd here). */
const CMD_SHIM_EXE = (exe: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  `"%dp0%\\${exe}"   %*`, '',
].join('\r\n');

let root: string;
let calls: string;
let preload: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  // A space and a quote in every path: an argv handed to a shell as one string would come apart on them.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tars cli-update 'win' ")));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  preload = path.join(root, 'fake-claude.cjs');
  fs.writeFileSync(preload, FAKE_CLAUDE);
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** NODE_OPTIONS for the preload: its parser reads a backslash inside quotes as an escape, so the path goes with forward slashes. */
const requirePreload = () => `--require "${preload.replace(/\\/g, '/')}"`;

/** node.exe under another name: a hard link, which needs no privilege, else a copy. */
function nodeAs(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.linkSync(process.execPath, file); } catch { fs.copyFileSync(process.execPath, file); }
}

function recorded(): string[][] {
  return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function logLines(ctx: CliUpdateContext): string[] {
  return fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, 'utf8').split('\n').filter(Boolean) : [];
}

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function ctxFor(home: string, env: Record<string, string> = {}, extraPath: string[] = []): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    env: {
      USERPROFILE: home,
      HOME: home,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: [...extraPath, path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'), SYSTEM32].join(';'),
      NODE_OPTIONS: requirePreload(),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

/** %USERPROFILE%\.local\bin\claude.exe, a copy of versions\<version>, as the native installer leaves it. */
function nativeClaude(home: string, version = '1.0.0'): string {
  const launcher = path.join(home, '.local', 'bin', 'claude.exe');
  nodeAs(path.join(home, '.local', 'share', 'claude', 'versions', version));
  nodeAs(launcher);
  return launcher;
}

function launcherVersion(home: string): string | undefined {
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  const size = fs.statSync(path.join(home, '.local', 'bin', 'claude.exe')).size;
  return fs.readdirSync(versions).find(v => fs.statSync(path.join(versions, v)).size === size);
}

/** %APPDATA%\npm with npm's own shim and a fake npm cli, and node.exe beside them as the shims prefer. */
function npmPrefix(home: string): string {
  const prefix = path.join(home, 'AppData', 'Roaming', 'npm');
  fs.mkdirSync(path.join(prefix, 'node_modules', 'npm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'), FAKE_NPM);
  fs.writeFileSync(path.join(prefix, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '10.9.9' }));
  fs.writeFileSync(path.join(prefix, 'npm.cmd'), CMD_SHIM_NODE('node_modules\\npm\\bin\\npm-cli.js'));
  nodeAs(path.join(prefix, 'node.exe'));
  return prefix;
}

/** amp.cmd over @sourcegraph/amp's script, in the prefix, as `npm install -g @sourcegraph/amp` leaves it. */
function npmAmp(prefix: string, version = '0.0.1', owner = '@sourcegraph/amp', shim = 'amp'): string {
  const pkgDir = path.join(prefix, 'node_modules', ...owner.split('/'));
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: owner, version }));
  const script = path.join(pkgDir, 'bin', `${shim}.js`);
  fs.writeFileSync(script, "console.log('ready'); setTimeout(() => {}, 60000);\n");
  fs.writeFileSync(path.join(prefix, `${shim}.cmd`), CMD_SHIM_NODE(path.relative(prefix, script)));
  return script;
}

async function startSession(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
    child.once('exit', code => reject(new Error(`the session exited (${code}) before it was ready`)));
  });
  return child;
}

describe.skipIf(!onWindows)('claude through its native installer, on Windows', () => {
  it('1, 2, 3. finds claude.exe, reads its version off the versions, runs `claude.exe update`, and reads the new one the same way', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const ctx = ctxFor(home);

    const [result] = await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctx);

    expect(result).toMatchObject({ cli: 'claude', outcome: 'updated', from: '1.0.0', to: '1.0.1' });
    expect(recorded()).toEqual([['claude', 'update']]);
    expect(launcherVersion(home)).toBe('1.0.1');
    expect(logLines(ctx)).toHaveLength(1);
    expect(logLines(ctx)[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z claude updated 1\.0\.0 to 1\.0\.1: Successfully updated from 1\.0\.0 to version 1\.0\.1 \(\d+\.\d s\)$/);
  });

  it('4. does not wait for a session running the launcher, which keeps running the copy set aside', async () => {
    const home = path.join(root, 'home');
    const launcher = nativeClaude(home);
    const ctx = ctxFor(home);
    const session = await startSession(launcher, ['-e', "console.log('ready'); setTimeout(() => {}, 60000)"], ctx.env);

    const result = await updateCli('claude', 'claude', ctx);

    expect(result).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.0.1' });
    expect(session.exitCode).toBeNull();
  });

  it('5. takes an update that exits 0 and moves nothing as unchanged, in claude\'s own words', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'current' }));

    expect(result).toMatchObject({ outcome: 'unchanged', from: '1.0.0', detail: 'Claude Code is up to date (1.0.0)' });
    expect(result.to).toBeUndefined();
  });

  it('5. logs a failure with the line that explains it', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'fail' }));

    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('Error: Failed to install native update; TelemetrySafeError: connect ECONNREFUSED');
    expect(result.detail).toContain('(exit 1');
    expect(launcherVersion(home)).toBe('1.0.0');
  });

  it('6. leaves alone a claude.exe in ~/.local/bin that is none of the installer\'s versions', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    // A different build put there by hand: one byte more than every version.
    const launcher = path.join(home, '.local', 'bin', 'claude.exe');
    fs.rmSync(launcher);
    fs.copyFileSync(process.execPath, launcher);
    fs.appendFileSync(launcher, Buffer.alloc(1));

    const result = await updateCli('claude', 'claude', ctxFor(home));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain(`installed through ${launcher}`);
    expect(recorded()).toEqual([]);
  });

  it('12. never touches an install that lives outside the home it runs in', async () => {
    const realHome = path.join(root, 'real-home');
    nativeClaude(realHome);
    const sandbox = path.join(root, 'sandbox-home');
    fs.mkdirSync(sandbox);

    const result = await updateCli('claude', 'claude', ctxFor(sandbox, {}, [path.join(realHome, '.local', 'bin')]));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('is outside');
    expect(recorded()).toEqual([]);
    expect(launcherVersion(realHome)).toBe('1.0.0');
  });

  it('13. says why a Settings path Windows cannot start is left, rather than that claude is missing', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const version = path.join(home, '.local', 'share', 'claude', 'versions', '1.0.0');

    const result = await updateCli('claude', version, ctxFor(home));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).not.toContain('not installed');
    expect(result.detail).toContain('not a Windows executable');
    expect(recorded()).toEqual([]);
  });

  it('1. says so when claude is not there', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    expect(await updateCli('claude', 'claude', ctxFor(home))).toMatchObject({ outcome: 'skipped', detail: 'not installed: claude not found' });
  });

  it('7. names claude installed by npm, a native exe inside its package, and runs nothing', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const pkgDir = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    nodeAs(path.join(pkgDir, 'bin', 'claude.exe'));
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.220' }));
    fs.writeFileSync(path.join(prefix, 'claude.cmd'), CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_LATEST: '9.9.9' }));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('installed through npm (@anthropic-ai/claude-code)');
    expect(recorded()).toEqual([]);
  });
});

describe.skipIf(!onWindows)('amp as a global npm package, on Windows', () => {
  it('8, 9. updates the package in %APPDATA%\\npm\\node_modules, through npm.cmd\'s node and script, with the arguments macOS gets', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });

    const [result] = await runCliUpdatePass([{ cli: 'amp', command: 'amp' }], ctx);

    expect(result).toMatchObject({ cli: 'amp', outcome: 'updated', from: '0.0.1', to: '0.0.2' });
    const npm = recorded();
    expect(npm.map(c => c.slice(0, 2))).toEqual([['npm', 'view'], ['npm', 'install'], ['npm', 'install']]);
    const cache = npm[0][npm[0].indexOf('--cache') + 1];
    expect(npm[0]).toEqual(['npm', 'view', '@sourcegraph/amp', 'version', '--prefix', prefix, '--cache', cache, '--fetch-retries=0']);
    const scratch = npm[1][npm[1].indexOf('--prefix') + 1];
    expect(scratch).not.toBe(prefix);
    expect(npm[1]).not.toContain('--global');
    expect(npm[1].at(-1)).toBe('@sourcegraph/amp@0.0.2');
    expect(npm[2]).toEqual(['npm', 'install', '--global', '--prefix', prefix, '--cache', cache, '--prefer-offline', '--no-audit', '--no-fund', '@sourcegraph/amp@0.0.2']);
    expect(fs.existsSync(path.dirname(cache))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@sourcegraph', 'amp', 'package.json'), 'utf8')).version).toBe('0.0.2');
  });

  it('10. waits while a process runs the package, and updates once it has ended', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const script = npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    const session = await startSession(process.execPath, [script], ctx.env);

    const held = await updateCli('amp', 'amp', ctx);

    expect(held.outcome).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
    expect(recorded().map(c => c[1])).toEqual(['view']);

    session.kill();
    await new Promise(resolve => session.once('exit', resolve));

    const done = await updateCli('amp', 'amp', ctx);
    expect(done).toMatchObject({ outcome: 'updated', from: '0.0.1', to: '0.0.2' });
  });

  it('11. holds an update back when it cannot tell whether Amp is running', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    npmAmp(prefix);
    // PowerShell cannot be started: nothing can list the processes.
    listingBroken.value = true;
    let result;
    try {
      result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: '0.0.2' }));
    } finally {
      listingBroken.value = false;
    }

    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'deferred' });
    expect(result.detail).toContain('could not be checked');
    expect(recorded().map(c => c[1])).toEqual(['view']);
  });

  it('12. never touches a global prefix outside the home it runs in', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    const prefix = npmPrefix(elsewhere);
    npmAmp(prefix);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    const result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: '0.0.2' }, [prefix]));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('is outside');
    expect(recorded()).toEqual([]);
  });
});

describe.skipIf(!onWindows)('the schedule main.ts starts, on Windows', () => {
  it('14. updates the native claude a launch would find, 5 s after it starts, into ~/.dorothy/cli-updates.log', async () => {
    // The suite's throwaway home, where the app's paths point: buildFullPath
    // adds its ~/.local/bin. The PATH it starts from is narrowed to System32
    // for the case, so no CLI of this machine's is on it.
    const home = os.homedir();
    nativeClaude(home);
    const saved = { path: process.env.PATH, options: process.env.NODE_OPTIONS, calls: process.env.FAKE_CALLS };
    process.env.PATH = SYSTEM32;
    process.env.NODE_OPTIONS = requirePreload();
    process.env.FAKE_CALLS = calls;
    try {
      startCliUpdates(() => ({ cliPaths: { claude: '', amp: '' } }) as unknown as AppSettings, () => ['claude']);
      await vi.waitFor(() => {
        expect(fs.existsSync(CLI_UPDATES_LOG) && fs.readFileSync(CLI_UPDATES_LOG, 'utf8')).toContain('claude updated 1.0.0 to 1.0.1');
      }, { timeout: 30_000, interval: 250 });
      expect(CLI_UPDATES_LOG).toBe(path.join(home, '.dorothy', 'cli-updates.log'));
      expect(recorded()).toEqual([['claude', 'update']]);
    } finally {
      process.env.PATH = saved.path;
      if (saved.options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.options;
      if (saved.calls === undefined) delete process.env.FAKE_CALLS; else process.env.FAKE_CALLS = saved.calls;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  });
});
