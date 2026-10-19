import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A test build (`npm run electron:pack`, "Tars Sandbox") runs on a home of its
 * own, never on the account's (the Audit's M1 on #477). Its own name gives it
 * its own Electron profile, so its own single-instance lock: opened from the
 * Finder, the Dock or `open`, without scripts/sandbox.sh, it started beside the
 * real Tars on the real home, its agents, settings and tokens, its Telegram and
 * Slack bots and port 31415. Moving itself to ~/Tars-sandbox at that point
 * cannot be done whole: macOS reads CFFIXED_USER_HOME as the process starts,
 * and the bus and the hooks' owner check read the password database's home
 * (os.userInfo), whatever HOME says. So it refuses, and says how to start it.
 */

/** Whether this build is a test build: its own package.json says so (`electron:pack` sets `tarsSandbox`), and nothing else does. */
export function isSandboxBuild(appPath: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')) as { tarsSandbox?: unknown }).tarsSandbox === true;
  } catch {
    return false;
  }
}

/**
 * The account's home as the password database names it, which HOME does not
 * move. An E2E run cannot hand the real one to a build under test, so it names
 * a stand-in, read under DOROTHY_E2E only.
 */
export function passwdHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DOROTHY_E2E === '1' && env.DOROTHY_E2E_PASSWD_HOME) return env.DOROTHY_E2E_PASSWD_HOME;
  return os.userInfo().homedir;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Why this start must not go on, or null: a test build on the account's own home. */
export function sandboxRefusal(o: { sandbox: boolean; home: string; passwdHome: string }): string | null {
  if (!o.sandbox || real(o.home) !== real(o.passwdHome)) return null;
  return `Tars Sandbox is a test build and starts only on a home of its own, through scripts/sandbox.sh (HOME ~/Tars-sandbox, port 31499). Started on ${o.home}, it would run on the real Tars's agents, settings, tokens, bots and port: it stops here, having touched nothing.`;
}

/** Whether this build asks GitHub for a new version: a test build never does, or it would offer the real Tars. */
export function checksForUpdates(o: { sandbox: boolean }): boolean {
  return !o.sandbox;
}
