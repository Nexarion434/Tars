import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A Tars started from a Claude Code session (`npm run electron:start` run by
 * one, as on 2026-10-09 with the dev Tars of the win-machines worktree)
 * carries that session's markers, CLAUDECODE and CLAUDE_CODE_CHILD_SESSION,
 * and handed them to every agent it started. An interactive claude that
 * inherits CLAUDE_CODE_CHILD_SESSION saves no transcript: it says "Transcript
 * saving is off, inherited CLAUDE_CODE_CHILD_SESSION marker" (Claude Code
 * 2.1.284), and no resume, usage or memory can find that conversation after.
 *
 * What can go wrong, each checked below, on the environment the process gets:
 * 1. An agent terminal (spawnAgentPty, the one line every agent process starts
 *    on) receives either marker, from its caller's environment.
 * 2. The main start (initAgentPty) copies Tars's own environment, markers
 *    included: it removed neither.
 * 3. A variable that only looks like one is removed with them: the session
 *    persistence override, the temporary folder, the traffic switch a local
 *    agent needs. Only the two markers go.
 * 4. A provider that runs the claude binary forgets one in the list of what
 *    its starts remove, or in the scheduled script it writes (`unset`).
 *
 * These assert what the process is handed, with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE
 * out of the way: set, it hides the lost transcript on a real run.
 */

const spawnCalls: Array<{ env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'test-uuid') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));
vi.mock('../../../electron/services/tasmania-client', () => ({
  getTasmaniaStatus: vi.fn(async () => ({ status: 'stopped' })),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { initAgentPty, agents } from '../../../electron/core/agent-manager';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { getAllProviders } from '../../../electron/providers';
import type { AgentStatus } from '../../../electron/types';
import { moveTestHome } from '../../setup/test-home';

const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-nested-markers-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-nested-markers-cwd-'));
let restoreHome: () => void;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  spawnCalls.length = 0;
  agents.clear();
  restoreHome = moveTestHome(home);
  expect(os.homedir()).toBe(home);
  // Tars as a Claude Code session starts it, without the override that hides the bug.
  for (const k of [...MARKERS, 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']) saved[k] = process.env[k];
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  delete process.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE;
});

afterEach(() => {
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('an agent started by a Tars that a Claude Code session started', () => {
  it('1. an agent terminal gets neither marker, whatever its caller passed', () => {
    spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd, cols: 80, rows: 24,
      env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_AGENT_ID: 'a1' },
    });
    const env = spawnCalls[spawnCalls.length - 1].env;
    for (const k of MARKERS) expect(env[k], k).toBeUndefined();
  });

  it('2. the main start copies Tars\'s environment without them', async () => {
    const agent = {
      id: 'agent-main-start', name: 'Main start', status: 'idle', provider: 'claude',
      projectPath: cwd, skills: [], output: [], lastActivity: new Date().toISOString(),
    } as AgentStatus;
    await initAgentPty(agent, null, vi.fn(), vi.fn());
    expect(spawnCalls).toHaveLength(1);
    for (const k of MARKERS) expect(spawnCalls[0].env[k], k).toBeUndefined();
  });

  it('3. only the two markers go', () => {
    spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd, cols: 80, rows: 24,
      env: {
        CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SOMETHING_ELSE: 'kept',
      },
    });
    const env = spawnCalls[spawnCalls.length - 1].env;
    expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.CLAUDE_CODE_SOMETHING_ELSE).toBe('kept');
  });

  it('4. every provider that runs claude removes both, in its starts and in its scheduled script', () => {
    const claudeRunners = getAllProviders().filter(p => p.binaryName === 'claude');
    expect(claudeRunners.length).toBeGreaterThan(10);
    for (const p of claudeRunners) {
      expect(p.getEnvVarsToDelete(), p.id).toEqual(expect.arrayContaining(MARKERS));
      const script = p.buildScheduledScript({
        binaryPath: '/bin/claude', binaryDir: '/bin', projectPath: cwd, prompt: 'Say hi', autonomous: false,
        mcpConfigPath: path.join(home, 'mcp.json'), logPath: path.join(home, 'log.txt'), homeDir: home,
      });
      const unset = script.split('\n').filter(l => /^\s*unset\b/.test(l)).join(' ');
      for (const k of MARKERS) expect(unset, `${p.id} scheduled script`).toContain(k);
    }
  });
});
