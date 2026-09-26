import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main, sandboxPlan } from '../../scripts/sandbox.mjs';

/**
 * `npm run sandbox`: a second Tars beside the live one, in a home of its own
 * (audit B, P-04).
 *
 * macOS and Linux: exactly what it always ran, `bash scripts/sandbox.sh <args>`,
 * its exit code handed back. Windows, where `bash` is the WSL launcher: the
 * unpacked build, release\win-unpacked\Tars.exe, started detached with its log
 * in a file, every profile variable in %USERPROFILE%\Tars-sandbox and the API
 * on 31499.
 *
 * How it can fail, each case below:
 *  - macOS or Linux runs anything but `bash scripts/sandbox.sh`, or loses its
 *    exit code;
 *  - on Windows, one profile variable left on the real profile (Electron's
 *    appData follows USERPROFILE, os.homedir() too, HOME is read by the hooks),
 *    no --user-data-dir, the port not 31499, or the live instance's API URL
 *    and token handed on, so the sandbox's agents post into it;
 *  - no USERPROFILE to put the sandbox in, guessed instead of refused;
 *  - a missing Tars.exe: folders made, or a spawn tried, before saying so.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

describe('the plan', () => {
  it('macOS and Linux: bash scripts/sandbox.sh with the same arguments', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(sandboxPlan({ platform, env: {}, argv: ['/Apps/Tars.app', '--x'], cwd: ROOT, scriptDir: SCRIPTS })).toEqual({
        kind: 'posix', command: 'bash', args: [path.join('scripts', 'sandbox.sh'), '/Apps/Tars.app', '--x'],
      });
    }
  });

  it('Windows: every profile variable in %USERPROFILE%\\Tars-sandbox, port 31499, its own Chromium profile', () => {
    const plan = sandboxPlan({
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\me', HOME: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATH: 'C:\\bin',
        DOROTHY_API_PORT: '31415', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415', CLAUDE_MGR_API_TOKEN: 'live', CLAUDECODE: '1',
      },
      argv: [],
      cwd: 'C:\\repo',
      scriptDir: 'C:\\repo\\scripts',
    });
    const sandbox = 'C:\\Users\\me\\Tars-sandbox';
    expect(plan).toMatchObject({
      kind: 'win32',
      exe: 'C:\\repo\\release\\win-unpacked\\Tars.exe',
      sandbox,
      log: `${sandbox}\\tars.log`,
      args: [`--user-data-dir=${sandbox}\\AppData\\Roaming\\Tars`],
    });
    expect(plan.env).toEqual({
      PATH: 'C:\\bin',
      USERPROFILE: sandbox,
      HOME: sandbox,
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\me\\Tars-sandbox',
      APPDATA: `${sandbox}\\AppData\\Roaming`,
      LOCALAPPDATA: `${sandbox}\\AppData\\Local`,
      DOROTHY_API_PORT: '31499',
    });
  });

  it('Windows: a Tars.exe given first, the rest handed to the app', () => {
    const plan = sandboxPlan({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me' }, argv: ['D:\\Tars\\Tars.exe', '--flag'], cwd: 'C:\\repo', scriptDir: 'C:\\repo\\scripts' });
    expect(plan).toMatchObject({ exe: 'D:\\Tars\\Tars.exe', args: ['--user-data-dir=C:\\Users\\me\\Tars-sandbox\\AppData\\Roaming\\Tars', '--flag'] });
  });

  it('Windows: refuses to guess where the sandbox goes without USERPROFILE', () => {
    expect(() => sandboxPlan({ platform: 'win32', env: {}, argv: [], cwd: 'C:\\repo', scriptDir: 'C:\\repo\\scripts' })).toThrow(/USERPROFILE/);
  });
});

describe('npm run sandbox', () => {
  let home: string;
  let out: string[];
  const log = (line: string) => out.push(line);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-test-'));
    out = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('macOS and Linux: hands back what bash exited with', () => {
    const spawnSync = vi.fn(() => ({ status: 3 }));
    const code = main(['/Apps/Tars.app'], { platform: 'darwin', env: {}, cwd: ROOT, spawnSync, log });
    expect(code).toBe(3);
    expect(spawnSync).toHaveBeenCalledWith('bash', [path.join('scripts', 'sandbox.sh'), '/Apps/Tars.app'], { stdio: 'inherit' });
  });

  // Real folders, named with Windows paths: only a Windows file system makes them what they say.
  const onWindows = process.platform === 'win32';

  it.runIf(onWindows)('Windows: makes the sandbox, logs to its file, starts the app detached, and says where', () => {
    const exe = path.join(home, 'Tars.exe');
    fs.writeFileSync(exe, '');
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ pid: 4242, unref }));

    const code = main([exe], { platform: 'win32', env: { USERPROFILE: home }, cwd: ROOT, spawn, log });

    expect(code).toBe(0);
    const sandbox = path.join(home, 'Tars-sandbox');
    for (const dir of ['AppData\\Roaming', 'AppData\\Local']) expect(fs.statSync(path.win32.join(sandbox, dir)).isDirectory()).toBe(true);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; detached: boolean; stdio: unknown[] }];
    expect(command).toBe(exe);
    expect(args[0]).toBe(`--user-data-dir=${path.win32.join(sandbox, 'AppData', 'Roaming', 'Tars')}`);
    expect(options.env.USERPROFILE).toBe(path.win32.join(sandbox));
    expect(options.detached).toBe(true);
    expect(options.stdio[0]).toBe('ignore');
    expect(typeof options.stdio[1]).toBe('number');
    expect(unref).toHaveBeenCalled();
    expect(fs.existsSync(path.join(sandbox, 'tars.log'))).toBe(true);
    expect(out.join('\n')).toMatch(/PID 4242/);
    expect(out.join('\n')).toContain('31499');
  });

  it.runIf(onWindows)('Windows: a missing Tars.exe is said, before any folder or spawn', () => {
    const spawn = vi.fn();
    const code = main([path.join(home, 'nope', 'Tars.exe')], { platform: 'win32', env: { USERPROFILE: home }, cwd: ROOT, spawn, log });
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/release:win/);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, 'Tars-sandbox'))).toBe(false);
  });
});
