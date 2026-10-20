import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort, PORT_OFFSET } from './ports.mjs';

/**
 * A real Claude Code run from inside an agent's own terminal, the state mod
 * loaded in both, does not take the agent's session (the gate of #380, B1).
 *
 * The stand-in spec (nested-cli-session.spec.ts) runs Tars's shell hooks only.
 * The Audit measured what it missed: the state mod reads its own process's
 * environment, where a nested claude has the CLAUDE_PID of the claude that
 * started it, the agent's own; sent as its CLI's pid, it was the terminal's,
 * and the nested session was registered through the mod.
 *
 * One agent on the native claude (2.1.289 or newer, so Tars hands it the state
 * mod), talking to the stub Messages API with no credentials and no network,
 * is told `NESTED n1`: the stub answers with one Bash call, `<claude> -p "LINES
 * 1 innern1"`, which the agent's claude runs in its own terminal. The nested
 * claude inherits the agent's id, its token, the hooks and the mod.
 * Asserted: the nested claude ran (its request reached the stub), and the
 * agent's session, the session a restart resumes, are still its own.
 * The artefact: values.json, the stub's log, and the app trace.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;
const AM = `${DIST}/core/agent-manager.js`;
const PM = `${DIST}/core/pty-manager.js`;
const STUB = 31983 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

test("a real claude run inside an agent's terminal, the state mod in both, does not take the agent's session", async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  test.setTimeout(6 * 60_000);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');

  const home = fs.mkdtempSync('/tmp/tars-nested-live-');
  const project = path.join(home, 'projects', 'nested');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2));
  const version = path.basename(CLAUDE);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([{
    id: 'w', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [], output: [],
    permissionMode: 'bypass', cliPath: CLAUDE, lastActivity: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: CLAUDE } }, null, 2));

  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG, FAKE_NESTED_CLI: CLAUDE }, stdio: 'ignore',
  });
  const stubLines = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { last?: string }) : []);
  const values: Record<string, unknown> = { claude: CLAUDE };
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31458), DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      type A = { currentSessionId?: string; resumableSessionId?: string; output?: string[] };
      const worker = () => app.evaluate((_e, am) => {
        const a = (process as unknown as { mainModule: { require(m: string): { agents: Map<string, A> } } }).mainModule.require(am).agents.get('w');
        return a ? { currentSessionId: a.currentSessionId, resumableSessionId: a.resumableSessionId, output: (a.output ?? []).join('').slice(-4000) } : null;
      }, AM);
      await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'w', prompt: '' }));
      await expect.poll(async () => (await worker())?.currentSessionId ?? null, { timeout: 90_000 }).not.toBeNull();
      const own = (await worker())!.currentSessionId!;
      values.before = await worker();
      await app.evaluate((_e, [am, pm, t]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(am).agents as Map<string, { ptyId?: string }>).get('w');
        const { ptyProcesses, writeProgrammaticInput } = req(pm) as { ptyProcesses: Map<string, unknown>; writeProgrammaticInput: (p: unknown, t: string, s: boolean) => unknown };
        return a?.ptyId ? !!writeProgrammaticInput(ptyProcesses.get(a.ptyId), t, true) : false;
      }, [AM, PM, 'NESTED n1'] as const);
      // The nested claude reached the stub: it ran, its SessionStart (shell hook and mod) went before it.
      await expect.poll(() => stubLines().some((l) => (l.last ?? '').includes('innern1')), { timeout: 120_000 }).toBe(true);
      await page.waitForTimeout(8_000);
      const after = await worker();
      values.after = after;
      values.stub = stubLines().map((l) => l.last).filter(Boolean);
      recordValues(values);
      expect(after!.currentSessionId, "the agent's session stays its own").toBe(own);
      expect(after!.resumableSessionId, 'a restart resumes its own conversation').toBe(own);
    } finally {
      await app.close();
    }
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
