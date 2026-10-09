import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

/**
 * The bots name a project by its folder, with or without a trailing `/`.
 *
 * Telegram's /agents and /status, Slack's agent lists, Discord's agent lines
 * and the /projects reply of all three took `projectPath.split('/').pop()`. A
 * project saved as `/Users/noah/atlas/` (a path pasted with its trailing slash)
 * was named '' in Telegram's /agents and 'Unknown' everywhere else. The chat
 * rooms already dropped the slash (bus-store's `filter(Boolean)`).
 *
 * How it can fail, written before the fix:
 * 1. a trailing `/`, or several, gives '' or 'Unknown' instead of the folder;
 * 2. anything else changes: the last segment of an ordinary path or a relative
 *    one, a `\` kept inside a name (an ordinary character on macOS and Linux);
 * 3. `/` or an empty path gives a name, or throws, instead of '', so the
 *    caller's own fallback ('Unknown', or nothing) no longer applies;
 * 4. a site keeps its own rule: Telegram's /agents line, Slack's line and the
 *    /projects reply each name the project as the helper does.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.5' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { projectFolderName, formatAgentStatus, formatSlackAgentStatus } from '../../../electron/utils';
import { projectsReport } from '../../../electron/services/bot-core';
import type { AgentStatus } from '../../../electron/types';

const agent = (projectPath: string): AgentStatus => ({
  id: 'agent-atlas', name: 'Dune', status: 'idle', role: 'worker', projectPath, skills: [], output: [],
  lastActivity: new Date(0).toISOString(), provider: 'claude',
} as unknown as AgentStatus);

describe('projectFolderName', () => {
  it('1. a trailing slash, or several, is dropped', () => {
    expect(projectFolderName('/Users/noah/atlas/')).toBe('atlas');
    expect(projectFolderName('/home/noah/atlas//')).toBe('atlas');
  });

  it('2. the last segment otherwise, as before', () => {
    expect(projectFolderName('/Users/noah/Projects/tars')).toBe('tars');
    expect(projectFolderName('relative/name')).toBe('name');
    expect(projectFolderName('/Users/noah/a\\b')).toBe('a\\b');
    expect(projectFolderName('/Users/noah/My Project')).toBe('My Project');
  });

  it('3. no name for the root or an empty path', () => {
    for (const p of ['/', '//', '']) expect(projectFolderName(p), JSON.stringify(p)).toBe('');
  });
});

describe('4. what the bots say', () => {
  const dot = { running: 'R', waiting: 'W', error: 'E', stopped: 'S', idle: 'I', asleep: 'Z' };

  it('Telegram\'s /agents line names the folder', () => {
    expect(formatAgentStatus(agent('/Users/noah/atlas/'))).toContain('Project: `atlas`');
  });

  it('Slack\'s line names the folder, not Unknown', () => {
    expect(formatSlackAgentStatus(agent('/Users/noah/atlas/'))).toContain('`atlas`');
  });

  it('the /projects reply names the folder, not Unknown', () => {
    const report = projectsReport(new Map([['agent-atlas', agent('/Users/noah/atlas/')]]), {
      title: '', folder: 'F', indent: '  ', people: 'P', face: () => '', dot,
    });
    expect(report).toContain('F *atlas*');
  });

  it('a root still falls back as before: Unknown, or nothing', () => {
    expect(formatSlackAgentStatus(agent('/'))).toContain('`Unknown`');
    expect(formatAgentStatus(agent('/'))).toContain('Project: ``');
  });
});
