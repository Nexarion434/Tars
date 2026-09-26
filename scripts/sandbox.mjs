#!/usr/bin/env node
/**
 * `npm run sandbox`: a second Tars beside the live one, in a home of its own.
 *
 * macOS and Linux: exactly what the script always was, `bash scripts/sandbox.sh
 * <args>` (HOME and CFFIXED_USER_HOME in ~/Tars-sandbox, API on 31499), its
 * output and exit code handed back as they are.
 *
 * Windows, where `bash` is the WSL launcher and sandbox.sh cannot run:
 *
 *   npm run sandbox                          release\win-unpacked\Tars.exe (npm run release:win builds it)
 *   npm run sandbox -- D:\x\Tars.exe [args]  another build, the rest handed to the app
 *
 * starts the app detached, its output in %USERPROFILE%\Tars-sandbox\tars.log,
 * with every variable Windows names a profile by moved into that folder:
 * USERPROFILE (os.homedir(), so ~/.dorothy and ~/.claude, and Electron's own
 * appData), HOME (read by the hooks and Git Bash), HOMEDRIVE and HOMEPATH,
 * APPDATA and LOCALAPPDATA, and the Chromium profile with --user-data-dir. The
 * API is on 31499, so the live Tars (31415) is neither seen nor touched, and
 * the live one's CLAUDE_MGR_* and DOROTHY_* are not handed on: an agent started
 * in the sandbox posts to the sandbox. The sandbox persists between launches;
 * delete the folder to start over.
 *
 * Tested in __tests__/scripts/sandbox.test.ts.
 */
import * as childProcess from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_PORT = '31499';
/** What the live Tars hands the processes it starts, and a sandbox must not inherit. */
const LIVE = /^(CLAUDE_MGR_|DOROTHY_)|^CLAUDECODE$/;

/** What to run, with nothing started yet. */
export function sandboxPlan({ platform, env, argv, cwd, scriptDir }) {
  if (platform !== 'win32') {
    return { kind: 'posix', command: 'bash', args: [path.relative(cwd, path.join(scriptDir, 'sandbox.sh')), ...argv] };
  }
  const win = path.win32;
  if (!env.USERPROFILE) throw new Error('USERPROFILE is not set: there is no profile to put Tars-sandbox in');
  const sandbox = win.join(env.USERPROFILE, 'Tars-sandbox');
  const given = argv[0] !== undefined && /\.exe$/i.test(argv[0]);
  const exe = given ? win.resolve(cwd, argv[0]) : win.join(scriptDir, '..', 'release', 'win-unpacked', 'Tars.exe');
  const roaming = win.join(sandbox, 'AppData', 'Roaming');
  const local = win.join(sandbox, 'AppData', 'Local');
  const drive = win.parse(sandbox).root.replace(/[\\/]+$/, '');
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !LIVE.test(name)));
  return {
    kind: 'win32',
    exe,
    sandbox,
    log: win.join(sandbox, 'tars.log'),
    dirs: [roaming, local],
    args: [`--user-data-dir=${win.join(roaming, 'Tars')}`, ...argv.slice(given ? 1 : 0)],
    env: {
      ...kept,
      USERPROFILE: sandbox,
      HOME: sandbox,
      HOMEDRIVE: drive,
      HOMEPATH: sandbox.slice(drive.length),
      APPDATA: roaming,
      LOCALAPPDATA: local,
      DOROTHY_API_PORT: SANDBOX_PORT,
    },
  };
}

export function main(argv = process.argv.slice(2), {
  platform = process.platform, env = process.env, cwd = process.cwd(),
  spawn = childProcess.spawn, spawnSync = childProcess.spawnSync, log = console.log,
} = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  let plan;
  try {
    plan = sandboxPlan({ platform, env, argv, cwd, scriptDir });
  } catch (err) {
    log(`sandbox: ${err.message}`);
    return 1;
  }
  if (plan.kind === 'posix') {
    const r = spawnSync(plan.command, plan.args, { stdio: 'inherit' });
    if (r.error) {
      log(`sandbox: could not run bash: ${r.error.message}`);
      return 1;
    }
    return r.status ?? 1;
  }

  if (!existsSync(plan.exe)) {
    log(`App not found: ${plan.exe}`);
    log('Build it first (npm run release:win), or pass its path: npm run sandbox -- C:\\path\\Tars.exe');
    return 1;
  }
  for (const dir of plan.dirs) mkdirSync(dir, { recursive: true });
  log(`Sandbox home : ${plan.sandbox}`);
  log(`API port     : ${SANDBOX_PORT} (the live Tars stays on 31415)`);
  log(`App          : ${plan.exe}`);
  const out = openSync(plan.log, 'a');
  try {
    const child = spawn(plan.exe, plan.args, { env: plan.env, detached: true, stdio: ['ignore', out, out], windowsHide: false });
    child.unref();
    log(`PID ${child.pid}: both Tars run side by side. Logs: ${plan.log}`);
  } finally {
    closeSync(out);
  }
  return 0;
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main();
}
