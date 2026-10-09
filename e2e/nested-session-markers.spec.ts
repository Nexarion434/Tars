import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Tars started from a Claude Code session carries its markers, CLAUDECODE
 * and CLAUDE_CODE_CHILD_SESSION, and handed them to its agents: an interactive
 * claude with the second saves no transcript (2026-10-09, the dev Tars of the
 * win-machines worktree, started by a Claude Code session).
 *
 * Asserted, in the real app started with both markers: an agent started from
 * the window runs a CLI, a recorder of its own environment, that receives
 * neither (every other start goes through the same spawnAgentPty, which
 * __tests__/electron/core/nested-session-markers.test.ts checks). CLAUDE_CODE_FORCE_SESSION_PERSISTENCE,
 * which hides the lost transcript on a real run, is not set.
 *   npx playwright test e2e/nested-session-markers.spec.ts
 */

const onWindows = process.platform === 'win32';
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'];

type Seen = { agentId: string | null; markers: Record<string, string | null>; forcePersistence: string | null };
type Api = { electronAPI: { agent: {
  create(config: Record<string, unknown>): Promise<{ id: string }>;
  start(params: { id: string; prompt: string }): Promise<{ success: boolean; error?: string }>;
} } };

function recorderScript(log: string): string {
  return [
    "const fs = require('fs');",
    `const markers = Object.fromEntries(${JSON.stringify(MARKERS)}.map(k => [k, process.env[k] ?? null]));`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agentId: process.env.CLAUDE_AGENT_ID || null, markers, forcePersistence: process.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE ?? null }) + '\\n');`,
    "process.stdout.write('the recorder of the nested session spec\\r\\n> ');",
    'process.stdin.resume();',
    '',
  ].join('\n');
}

function installRecorder(home: string, log: string): string {
  const dir = path.join(home, 'npm dir');
  const pkg = path.join(dir, 'node_modules', 'fake-claude');
  fs.mkdirSync(pkg, { recursive: true });
  if (!onWindows) {
    const file = path.join(dir, 'fake-claude.cjs');
    fs.writeFileSync(file, `#!${process.execPath}\n${recorderScript(log)}`, { mode: 0o755 });
    return file;
  }
  fs.writeFileSync(path.join(pkg, 'cli.js'), recorderScript(log));
  const shim = path.join(dir, 'fake-claude.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*', '',
  ].join('\r\n'));
  return shim;
}

test('a Tars started from a Claude Code session starts its agents without that session\'s markers', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-nested-markers-'));
  const dataDir = path.join(home, '.dorothy');
  const project = path.join(home, 'projects', 'demo');
  const log = path.join(home, 'seen.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const cli = installRecorder(home, log);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }, null, 2));
  

  // Tars as a Claude Code session starts it: both markers, no persistence override.
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31455), DOROTHY_E2E: '1', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1' },
  });
  const errors: string[] = [];
  const values: Record<string, unknown> = { platform: process.platform };
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    expect(await app.evaluate(() => [process.env.CLAUDECODE, process.env.CLAUDE_CODE_CHILD_SESSION]), 'Tars itself carries the markers').toEqual(['1', '1']);

    const seen = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Seen) : []);
    const seenBy = async (agentId: string) => {
      await expect.poll(() => seen().some(s => s.agentId === agentId), { timeout: 30_000, message: `the recorder never started for ${agentId}` }).toBe(true);
      return seen().find(s => s.agentId === agentId)!;
    };

    // From the window.
    const fromWindow = await page.evaluate(async (arg) => {
      const api = (window as unknown as Api).electronAPI.agent;
      const agent = await api.create({ projectPath: arg.project, skills: [], name: 'From the window', cliPath: arg.cli, permissionMode: 'normal' });
      const started = await api.start({ id: agent.id, prompt: 'Say hi' });
      if (!started.success) throw new Error(started.error ?? 'start failed');
      return agent.id;
    }, { project, cli });
    const windowSaw = await seenBy(fromWindow);
    expect(windowSaw.markers, JSON.stringify(windowSaw)).toEqual({ CLAUDECODE: null, CLAUDE_CODE_CHILD_SESSION: null });
    expect(windowSaw.forcePersistence).toBeNull();
    values.fromWindow = windowSaw;

    expect(errors, errors.join('\n')).toEqual([]);
    recordValues(values);
  } finally {
    await app.close();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
