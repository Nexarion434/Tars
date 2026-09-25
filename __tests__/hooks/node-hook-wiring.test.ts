import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the hooks are wired: `configureHooks` of the Claude and Gemini
 * providers, and the statusline, which write the CLIs' settings files.
 *
 * On win32 they write `node "<abs>/tars-hook.mjs" <event>` (decision D1). On
 * darwin and linux they write exactly what they wrote before: the same tests
 * pass against the code before this change, which is the proof.
 *
 * How the wiring can fail, written before the code:
 *  1. win32 keeps writing the bare `.sh` path: bash eats its backslashes, and
 *     no hook ever runs (audit A7).
 *  2. darwin or linux entries change in any byte (command, timeout, matcher,
 *     order, Gemini's file layout).
 *  3. A second run adds a second entry per event, or the old `.sh` entries a
 *     previous Tars wrote on Windows stay beside the new ones, so each event
 *     runs twice (or runs a dead `.sh` once more).
 *  4. Gemini's probe looks for `gemini/<file>` in a backslash path and appends
 *     a copy of every hook at each start (audit A11); those copies are kept.
 *  5. Gemini is wired on `UserPromptSubmit`, which it does not fire;
 *     `BeforeAgent` is its event (audit A12).
 *  6. The agent token cannot reach a Gemini hook once the user turns on
 *     environment redaction (`CLAUDE_MGR_API_TOKEN` matches /TOKEN/): it is
 *     not in `security.environmentVariableRedaction.allowed`; or adding it
 *     drops the user's own entries or flips `enabled`.
 *  7. The user's own hooks, in the same event, are removed or rewritten.
 *  8. The command is quoted so that Git Bash, or PowerShell (Claude without
 *     Git Bash, and Gemini always on Windows), splits the path at a space
 *     (the dev checkout is under "Claude Project"), expands a `$`, or chokes
 *     on a `'`.
 *  9. The statusline command is unquoted, or turning it off does not
 *     recognise the Node form as Tars's and leaves it behind.
 */

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-wiring-'));
const fwd = (p: string) => p.replace(/\\/g, '/');
const runnerCmd = (event: string) => `node "${fwd(path.join(HOOKS_DIR, 'tars-hook.mjs'))}" ${event}`;

const CLAUDE_EVENTS: Array<[string, string, string | undefined]> = [
  ['PostToolUse', 'post-tool-use', '*'],
  ['Stop', 'on-stop', undefined],
  ['StopFailure', 'stop-failure', undefined],
  ['SessionStart', 'session-start', '*'],
  ['SessionEnd', 'session-end', '*'],
  ['Notification', 'notification', '*'],
  ['PermissionRequest', 'permission-request', undefined],
  ['TaskCompleted', 'task-completed', undefined],
  ['UserPromptSubmit', 'user-prompt-submit', undefined],
];

let home = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmp, 'home-'));
  for (const k of ['HOME', 'USERPROFILE']) { saved[k] = process.env[k]; process.env[k] = home; }
  expect(os.homedir()).toBe(home);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.resetModules();
});

async function claude() {
  const { ClaudeProvider } = await import('../../electron/providers/claude-provider');
  const p = new ClaudeProvider();
  expect(p.configDir.startsWith(home), `would write into ${p.configDir}`).toBe(true);
  return p;
}
async function gemini() {
  const { GeminiProvider } = await import('../../electron/providers/gemini-provider');
  const p = new GeminiProvider();
  expect(p.configDir.startsWith(home), `would write into ${p.configDir}`).toBe(true);
  return p;
}
const claudeSettingsFile = () => path.join(home, '.claude', 'settings.json');
const geminiSettingsFile = () => path.join(home, '.gemini', 'settings.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

describe('on darwin and linux nothing changes', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`Claude writes the bare .sh path, timeout 30, the same matchers (${platform})`, async () => {
      const p = await claude();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      const expected: Record<string, unknown> = {};
      for (const [type, name, matcher] of CLAUDE_EVENTS) {
        expected[type] = [{ hooks: [{ type: 'command', command: path.join(HOOKS_DIR, `${name}.sh`), timeout: 30 }], ...(matcher ? { matcher } : {}) }];
      }
      expect(read(claudeSettingsFile())).toEqual({ hooks: expected });
      // Key order inside each entry, as JSON.stringify writes it.
      expect(JSON.stringify(read(claudeSettingsFile()).hooks.PostToolUse[0])).toBe(
        JSON.stringify({ hooks: [{ type: 'command', command: path.join(HOOKS_DIR, 'post-tool-use.sh'), timeout: 30 }], matcher: '*' }),
      );
    });

    it(`Gemini writes the .sh paths, UserPromptSubmit, timeout 10000, the same file text (${platform})`, async () => {
      const p = await gemini();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      const g = (f: string) => path.join(HOOKS_DIR, 'gemini', f);
      const expected = {
        hooks: {
          AfterTool: [{ hooks: [{ type: 'command', command: g('post-tool-use.sh'), timeout: 10000 }], matcher: '*' }],
          AfterAgent: [{ hooks: [{ type: 'command', command: g('on-stop.sh'), timeout: 10000 }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: g('session-start.sh'), timeout: 10000 }], matcher: '*' }],
          SessionEnd: [{ hooks: [{ type: 'command', command: g('session-end.sh'), timeout: 10000 }], matcher: '*' }],
          Notification: [{ hooks: [{ type: 'command', command: g('notification.sh'), timeout: 10000 }], matcher: '*' }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: g('user-prompt-submit.sh'), timeout: 10000 }] }],
        },
      };
      expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe(JSON.stringify(expected, null, 2));
    });
  }
});

describe('on win32, Claude runs the Node runner', () => {
  const configure = async () => {
    const p = await claude();
    await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
  };

  it('writes one `node "<abs>" <event>` entry per event, timeout 30, the same matchers', async () => {
    await configure();
    const hooks = read(claudeSettingsFile()).hooks;
    for (const [type, name, matcher] of CLAUDE_EVENTS) {
      expect(hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(name), timeout: 30 }], ...(matcher ? { matcher } : {}) }]);
    }
    expect(Object.keys(hooks).sort()).toEqual(CLAUDE_EVENTS.map(e => e[0]).sort());
  });

  it('twice yields the same file, and the second run writes nothing', async () => {
    await configure();
    const first = fs.readFileSync(claudeSettingsFile(), 'utf-8');
    const before = fs.statSync(claudeSettingsFile()).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    await configure();
    expect(fs.readFileSync(claudeSettingsFile(), 'utf-8')).toBe(first);
    expect(fs.statSync(claudeSettingsFile()).mtimeMs).toBe(before);
  });

  it('replaces the .sh entries a previous Tars wrote, removes their copies, keeps the user\'s hooks and settings', async () => {
    const winSh = (f: string) => `C:\\old\\Tars\\hooks\\${f}`;
    const userHook = { type: 'command', command: 'C:\\me\\my-stop.ps1', timeout: 5 };
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: winSh('on-stop.sh'), timeout: 30 }] },
          { hooks: [userHook] },
          { hooks: [{ type: 'command', command: winSh('on-stop.sh'), timeout: 30 }] },
        ],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: winSh('session-start.sh'), timeout: 45 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    }, null, 2));

    await configure();
    await configure();

    const s = read(claudeSettingsFile());
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }]);
    expect(s.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] },
      { hooks: [userHook] },
    ]);
    // The user's matcher and timeout on Tars's own entry are theirs to keep.
    expect(s.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [{ type: 'command', command: runnerCmd('session-start'), timeout: 45 }] }]);
    expect(JSON.stringify(s)).not.toContain('.sh');
  });

  it('points an entry of a moved checkout at this one', async () => {
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "D:/elsewhere/hooks/tars-hook.mjs" on-stop', timeout: 30 }] }] },
    }));
    await configure();
    expect(read(claudeSettingsFile()).hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] }]);
  });
});

describe('on win32, Gemini runs the Node runner on its own events, with the token allowed through', () => {
  const configure = async () => {
    const p = await gemini();
    await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
  };
  const G_EVENTS: Array<[string, string, string | undefined]> = [
    ['AfterTool', 'gemini/post-tool-use', '*'],
    ['AfterAgent', 'gemini/on-stop', undefined],
    ['SessionStart', 'gemini/session-start', '*'],
    ['SessionEnd', 'gemini/session-end', '*'],
    ['Notification', 'gemini/notification', '*'],
    ['BeforeAgent', 'gemini/user-prompt-submit', undefined],
  ];

  it('writes BeforeAgent, never UserPromptSubmit, one entry each, timeout 10000', async () => {
    await configure();
    const s = read(geminiSettingsFile());
    for (const [type, event, matcher] of G_EVENTS) {
      expect(s.hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(event), timeout: 10000 }], ...(matcher ? { matcher } : {}) }]);
    }
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    expect(s.security.environmentVariableRedaction.allowed).toEqual(['CLAUDE_MGR_API_TOKEN']);
    expect(s.security.environmentVariableRedaction.enabled).toBeUndefined();
  });

  it('cleans the copies the old probe appended at every start (A11), and the UserPromptSubmit entry', async () => {
    const sh = (f: string) => `C:\\old\\Tars\\hooks\\gemini\\${f}`;
    const entry = (f: string, matcher?: string) => ({ hooks: [{ type: 'command', command: sh(f), timeout: 10000 }], ...(matcher ? { matcher } : {}) });
    fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
    fs.writeFileSync(geminiSettingsFile(), JSON.stringify({
      theme: 'dark',
      security: { environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY'] }, folderTrust: { enabled: true } },
      hooks: {
        AfterTool: [entry('post-tool-use.sh', '*'), entry('post-tool-use.sh', '*'), entry('post-tool-use.sh', '*')],
        AfterAgent: [entry('on-stop.sh'), entry('on-stop.sh')],
        UserPromptSubmit: [entry('user-prompt-submit.sh'), entry('user-prompt-submit.sh')],
        BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'mine.ps1' }] }],
      },
    }, null, 2));

    await configure();
    await configure();

    const s = read(geminiSettingsFile());
    expect(s.theme).toBe('dark');
    expect(s.security).toEqual({ environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY', 'CLAUDE_MGR_API_TOKEN'] }, folderTrust: { enabled: true } });
    expect(s.hooks.BeforeTool).toEqual([{ matcher: 'x', hooks: [{ type: 'command', command: 'mine.ps1' }] }]);
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    for (const [type, event, matcher] of G_EVENTS) {
      expect(s.hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(event), timeout: 10000 }], ...(matcher ? { matcher } : {}) }]);
    }
  });

  it('twice writes nothing the second time', async () => {
    await configure();
    const first = fs.readFileSync(geminiSettingsFile(), 'utf-8');
    const before = fs.statSync(geminiSettingsFile()).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    await configure();
    expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe(first);
    expect(fs.statSync(geminiSettingsFile()).mtimeMs).toBe(before);
  });

  it('leaves a settings file that is not JSON untouched', async () => {
    fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
    fs.writeFileSync(geminiSettingsFile(), '{ not json');
    await configure();
    expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe('{ not json');
  });
});

describe('the command survives the shells that run it', () => {
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const onWindows = process.platform === 'win32';

  /** A stand-in runner that reports how it was called. */
  function probeIn(dirName: string): string {
    const dir = path.join(tmp, dirName, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'tars-hook.mjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ script: process.argv[1], args: process.argv.slice(2) }));\n');
    return script;
  }

  const DIRS = ['Claude Project', 'with $HOME and `tick`', "O'Brien space"];

  it.each(DIRS)('builds a command both shells read back to the same argv (%s)', async dirName => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    const script = probeIn(dirName);
    const command = nodeHookCommand(script, 'gemini/on-stop');
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };

    const shells: Array<[string, string, string[]]> = onWindows
      ? [
        // Claude Code's shell-form hooks: Git Bash when installed.
        ...(fs.existsSync(GIT_BASH) ? [['git-bash', GIT_BASH, ['-c', command]] as [string, string, string[]]] : []),
        // Claude Code without Git Bash, and Gemini CLI always (hookRunner, getShellConfiguration).
        ['powershell', 'powershell.exe', ['-NoProfile', '-Command', `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`]],
      ]
      : [['sh', '/bin/sh', ['-c', command]]];
    expect(shells.length).toBeGreaterThan(0);

    for (const [name, exe, args] of shells) {
      const r = spawnSync(exe, args, { env, encoding: 'utf8', windowsHide: true });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      const got = JSON.parse(r.stdout);
      expect(path.resolve(got.script), name).toBe(path.resolve(script));
      expect(got.args, name).toEqual(['gemini/on-stop']);
    }
  }, 60_000);

  it('uses forward slashes and double quotes for an ordinary path', async () => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    expect(nodeHookCommand('C:\\Users\\n\\Claude Project\\tars\\hooks\\tars-hook.mjs', 'on-stop'))
      .toBe('node "C:/Users/n/Claude Project/tars/hooks/tars-hook.mjs" on-stop');
    expect(nodeHookCommand('\\\\server\\share\\hooks\\statusline.mjs')).toBe('node "//server/share/hooks/statusline.mjs"');
  });

  it('refuses a path no quoting can carry through both shells', async () => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    expect(() => nodeHookCommand("C:\\a$b'c\\tars-hook.mjs", 'on-stop')).toThrow(/cannot be quoted/);
  });
});

describe('the statusline on win32', () => {
  async function statusline() {
    vi.doMock('../../electron/constants', async importOriginal => {
      const actual = await importOriginal<typeof import('../../electron/constants')>();
      return { ...actual, DATA_DIR: path.join(home, '.dorothy'), dataPath: (...s: string[]) => path.join(home, '.dorothy', ...s) };
    });
    return import('../../electron/utils/statusline');
  }

  it('is wired as node "<abs>/statusline.mjs", installs no .sh, and turns off cleanly', async () => {
    const s = await statusline();
    s.enableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toEqual({
      type: 'command', command: `node "${fwd(path.join(HOOKS_DIR, 'statusline.mjs'))}"`, padding: 1,
    });
    expect(fs.existsSync(path.join(home, '.dorothy', 'statusline.sh'))).toBe(false);
    expect(s.isStatusLineConfigured()).toBe(true);

    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toBeUndefined();
  });

  it('turns off a Node statusline written from another checkout, and leaves a user one alone', async () => {
    const s = await statusline();
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ statusLine: { type: 'command', command: 'node "D:/old/tars/hooks/statusline.mjs"', padding: 1 } }));
    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toBeUndefined();

    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ statusLine: { type: 'command', command: 'node "C:/me/my-line.mjs"' } }));
    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toEqual({ type: 'command', command: 'node "C:/me/my-line.mjs"' });
  });

  it('on darwin still installs statusline.sh and points at it', async () => {
    const s = await statusline();
    s.enableStatusLine({ platform: 'darwin' });
    const script = path.join(home, '.dorothy', 'statusline.sh');
    expect(read(claudeSettingsFile()).statusLine).toEqual({ type: 'command', command: script, padding: 1 });
    expect(fs.readFileSync(script, 'utf-8').startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});
