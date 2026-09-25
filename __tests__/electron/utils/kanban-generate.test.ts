import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import { CMD_SHIM_NODE, SH_SHIM, pinPlatform } from '../providers/win-fake-disk';

/**
 * Kanban "generate task": a one-shot `claude -p` that turns a request into a
 * task (audit A11, A24).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. The command line goes to a shell (`exec`): on Windows cmd.exe, where
 *    `'claude'` is no command and the prompt splits at its first newline,
 *    `&` chains a second command and %VAR% expands; on macOS /bin/sh, against
 *    the upstream Shell rule. The request and the project names are user text.
 * 2. The prompt does not reach the CLI as one argument, byte for byte: quotes,
 *    newlines, `$(...)`, backticks, `%PATH%`, `&`, `^`, `!` altered.
 * 3. darwin/linux: the argv differs from what /bin/sh made of the old command
 *    line, or the env is not `{ ...process.env, PATH: buildFullPath() }`.
 * 4. win32: claude.cmd (npm) is not found, or started through cmd.exe.
 * 5. A CLI that cannot be started is not said: the log must carry the
 *    resolver's reason, and the request still becomes a task (the fallback).
 */

let root: string;
let binDir: string;
let logFile: string;
let fakePath: string;
let savedLog: string | undefined;
let unpin: (() => void) | undefined;
const execCalls: string[] = [];
let captureExecFile: ((file: string, args: string[], opts: { env: Record<string, string> }) => string) | null = null;

vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: () => fakePath }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: (...args: Parameters<typeof actual.exec>) => {
      execCalls.push(String(args[0]));
      return actual.exec(...args);
    },
    execFile: (file: string, args: string[], opts: { env: Record<string, string> }, cb: (e: Error | null, out: string, err: string) => void) => {
      if (captureExecFile) {
        const stdout = captureExecFile(file, args, opts);
        setImmediate(() => cb(null, stdout, ''));
        return undefined as never;
      }
      return actual.execFile(file, args, opts, cb);
    },
  };
});

const TASK_JSON = JSON.stringify({ title: 'from the fake', description: 'd', projectPath: 'p', priority: 'high', labels: ['bug'], requiredSkills: [] });

function installFakeClaude() {
  const script = path.join(binDir, 'node_modules', 'fake-claude', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    'fs.appendFileSync(process.env.TARS_FAKE_CLI_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    `process.stdout.write(${JSON.stringify(TASK_JSON)});`,
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), CMD_SHIM_NODE('node_modules\\fake-claude\\cli.js'));
    fs.writeFileSync(path.join(binDir, 'claude'), SH_SHIM);
  } else {
    fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
}

const recorded = (): string[][] => (fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

async function generate(prompt: string, projects: Array<{ path: string; name: string }>) {
  const { generateTaskFromPrompt } = await import('../../../electron/utils/kanban-generate');
  return generateTaskFromPrompt(prompt, projects);
}

const HOSTILE = `Fix it's "quoted" bug\nsecond line $(whoami) \`id\` %PATH% & echo pwned ^ !x! 'end`;
const PROJECTS = [{ path: path.join('a b (x)', 'pro\'j'), name: 'pro"ject\'s & %USERNAME%' }];

beforeEach(() => {
  vi.resetModules();
  execCalls.length = 0;
  captureExecFile = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-kanban-gen-'));
  binDir = path.join(root, 'npm (x86) dir');
  fs.mkdirSync(binDir, { recursive: true });
  logFile = path.join(root, 'argv.jsonl');
  fakePath = [binDir, path.dirname(process.execPath)].join(path.delimiter);
  savedLog = process.env.TARS_FAKE_CLI_LOG;
  process.env.TARS_FAKE_CLI_LOG = logFile;
});

afterEach(() => {
  unpin?.();
  unpin = undefined;
  if (savedLog === undefined) delete process.env.TARS_FAKE_CLI_LOG;
  else process.env.TARS_FAKE_CLI_LOG = savedLog;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generateTaskFromPrompt', () => {
  it('reaches the installed claude with the prompt as one argument, byte for byte, and no shell', async () => {
    installFakeClaude();
    const task = await generate(HOSTILE, PROJECTS);

    const calls = recorded();
    expect(calls).toHaveLength(1);
    const [argv] = calls;
    expect(argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(argv).toHaveLength(4);
    expect(argv[3]).toContain(`User's request:\n${HOSTILE}\n`);
    expect(argv[3]).toContain(`- "${PROJECTS[0].name}" (${PROJECTS[0].path})`);
    expect(task.title).toBe('from the fake');
    expect(task.priority).toBe('high');
    expect(execCalls).toEqual([]);
  });

  it('darwin/linux: the argv /bin/sh made of the old command line, the env { ...process.env, PATH }', async () => {
    const sh = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh';
    if (!fs.existsSync(sh)) {
      console.warn(`skipped: no POSIX shell at ${sh} to compare with`);
      return;
    }
    unpin = pinPlatform('darwin');
    const seen: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    captureExecFile = (file, args, opts) => { seen.push({ file, args, env: opts.env }); return TASK_JSON; };

    await generate(HOSTILE, PROJECTS);

    expect(seen).toHaveLength(1);
    const [{ file, args, env }] = seen;
    const { getProvider } = await import('../../../electron/providers');
    const oldLine = getProvider('claude').buildOneShotCommand({ binaryPath: 'claude', prompt: args[3], model: 'haiku' });
    const shellArgv = childProcess.execFileSync(sh, ['-c', `printf '%s\\0' ${oldLine}`], {
      encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    }).split('\0').slice(0, -1);
    expect([file, ...args]).toEqual(shellArgv);
    expect(env).toEqual({ ...process.env, PATH: fakePath });
    expect(execCalls).toEqual([]);
  });

  it('win32: a claude that cannot be found is said, with the reason, and the request still becomes a task', async () => {
    unpin = pinPlatform('win32');
    fakePath = 'C:\\nowhere-tars-test';
    const said: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')); });

    const task = await generate('Ship the thing\nthen tell me', PROJECTS);

    expect(said.join('\n')).toMatch(/claude.*not-found/);
    expect(task.title).toBe('Ship the thing');
    expect(task.description).toBe('Ship the thing\nthen tell me');
    expect(recorded()).toEqual([]);
    expect(execCalls).toEqual([]);
  });
});
