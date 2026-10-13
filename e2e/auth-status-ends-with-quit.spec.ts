import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, seedSandbox, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A `claude auth status` Tars started ends with the quit, and writes nothing
 * into the home after it.
 *
 * Measured by QA on 2026-10-12 (QA-PR360.md): after app.close(), the process
 * still writing .claude.json and its lock into the sandbox HOME was `claude
 * auth status`, orphaned 1 ms after the quit. Listing the Claude accounts
 * (claude-accounts:list, at page load) checks in the background every account
 * whose sign-in is not known yet, with a 20 s timeout, and the quit ended the
 * version probes but not these. It is also what made a spec's cleanup fail
 * with ENOTEMPTY.
 *
 * The CLI is a stand-in named `claude` that, asked `auth status`, records its
 * pid, takes 4 s, then writes .claude.json into the home as claude does and
 * answers. Tars quits while it is in its 4 s.
 * Asserted: the stand-in is gone once the app is, and nothing appears in the
 * home in the 7 s after.
 * The artefact: values.json with the stand-in's pid, when it started, and
 * what the home held after.
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  fs.appendFileSync(path.join(process.env.HOME, 'auth-status.jsonl'), JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n');
  setTimeout(() => {
    fs.writeFileSync(path.join(process.env.HOME, '.claude.json'), JSON.stringify({ written: Date.now() }));
    process.stdout.write(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }, 4000);
} else {
  process.stdout.write('2.1.296 (Claude Code)\n');
}
`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a claude auth status Tars started ends with the quit and writes nothing after it', async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-auth-quit-'));
  seedSandbox(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  const settingsFile = path.join(home, '.dorothy', 'app-settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, autoStartAgentsOnLaunch: false, cliPaths: { ...(settings.cliPaths ?? {}), claude: cli } }, null, 2));
  const started = () => (fs.existsSync(path.join(home, 'auth-status.jsonl'))
    ? fs.readFileSync(path.join(home, 'auth-status.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pid: number; at: number }) : []);
  const marker = path.join(home, '.claude.json');
  if (fs.existsSync(marker)) fs.rmSync(marker);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31453), DOROTHY_E2E: '1' },
  });
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    await page.evaluate(() => (window as unknown as { electronAPI: { claudeAccounts: { list(): Promise<unknown> } } }).electronAPI.claudeAccounts.list());
    await expect.poll(() => started().length, { timeout: 30_000 }).toBeGreaterThan(0);
    // Quit while every check is still in its 4 s.
    const probes = started();
    await app.close();
    closed = true;
    const closedAt = Date.now();
    const pids = probes.map((p) => p.pid);
    const seen: Array<{ dt: number; alive: number[]; marker: boolean }> = [];
    while (Date.now() - closedAt < 7_000) {
      seen.push({ dt: Date.now() - closedAt, alive: pids.filter(alive), marker: fs.existsSync(marker) });
      await new Promise((r) => setTimeout(r, 250));
    }
    recordValues({ probes, closedAt, seen, homeAfter: fs.readdirSync(home) });
    expect(seen[0].alive, 'the checks are gone once the app is').toEqual([]);
    expect(seen.filter((s) => s.marker).map((s) => s.dt), 'nothing written into the home after the quit').toEqual([]);
  } finally {
    if (!closed) await app.close();
  }
});
