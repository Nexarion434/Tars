/**
 * Imported first by main.ts, before anything reads or writes the data folder:
 * a test build started on the account's own home stops here (core/sandbox-build.ts).
 * process.exit, not app.exit: app.exit returns, and the imports after this one
 * would run on the real home before the app quits. No dialog: a box on the
 * maintainer's screen is what a test build must never put there (18/10).
 */
import { app } from 'electron';
import * as os from 'os';
import { isSandboxBuild, passwdHome, sandboxRefusal } from './sandbox-build';

export const SANDBOX_BUILD = isSandboxBuild(app.getAppPath());

const why = sandboxRefusal({ sandbox: SANDBOX_BUILD, home: os.homedir(), passwdHome: passwdHome() });
if (why) {
  console.error(`[sandbox] ${why}`);
  process.exit(1);
}
