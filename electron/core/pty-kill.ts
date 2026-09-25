import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IPty } from 'node-pty';

/**
 * Ends a terminal without node-pty's `AttachConsole failed` (audit A22,
 * matrix row 17).
 *
 * node-pty 1.1 ends a ConPTY terminal (WindowsPtyAgent.kill, inbox ConPTY)
 * by forking lib/conpty_console_list_agent.js with the shell's pid, to list
 * the processes on its console and kill them. The helper frees its own
 * console, attaches to the shell's, and throws when the shell has none left:
 * every kill of a terminal whose shell has exited, and any whose shell exits
 * in the time the fork takes to start. Measured on Windows 11 26200 with
 * node-pty 1.1.0 (2026-09-25): 3 kills of 3 exited cmd.exe printed "Error:
 * AttachConsole failed" from the fork, under Node 22 and under Electron 44
 * alike. node-pty then waits five seconds for the list and kills the shell's
 * pid anyway, a pid Windows released when that shell exited and may have
 * handed to another process since. Here the helper's throw reached stderr
 * only; openai/codex#25272 reports it as an error dialog in an Electron app,
 * which is the failure the audit (A22) was reproduced from.
 *
 * So on win32, before kill() asks for that list, the terminal's agent is
 * given a list of its own: none once the shell has exited (there is no
 * console left to attach to, and no pid of its to trust); otherwise the same
 * helper, forked silently, whose failure means the shell has gone and gives
 * an empty list, and whose silence past five seconds gives the shell's pid
 * only while the shell still runs. Everything else kill() does, the pseudo
 * console, the sockets, the output worker, is node-pty's own.
 *
 * This reaches into node-pty's WindowsPtyAgent (`_agent`, its
 * `_getConsoleProcessList`, `_useConpty`, `_useConptyDll`, `_innerPid` and
 * `exitCode`), as installed at 1.1.0, and only a node-pty whose package.json
 * says 1.1.x is touched. Any other version, one whose version cannot be read,
 * any other shape, winpty, and `useConptyDll` (whose kill forks nothing) are
 * left to node-pty. darwin/linux: pty.kill(), and nothing of node-pty is read.
 */

export interface PtyKillDeps {
  platform?: NodeJS.Platform;
  fork?: (modulePath: string, args: string[], options: ForkOptions) => ChildProcess;
  /** node-pty's lib/conpty_console_list_agent.js. */
  listAgent?: string;
  /** How long the helper gets to answer, node-pty's own five seconds. */
  timeoutMs?: number;
  /** The installed node-pty's version, null when it cannot be read. Read from its package.json by default. */
  nodePtyVersion?: string | null;
}

/** The internals below are node-pty 1.1's; no other release was read. */
const HANDLED_NODE_PTY = /^1\.1\.\d+$/;

let installedVersion: string | null | undefined;

/** The installed node-pty's package.json version, read once; null when it cannot be read. */
function installedNodePtyVersion(): string | null {
  if (installedVersion !== undefined) return installedVersion;
  try {
    const manifest = path.join(path.dirname(require.resolve('node-pty')), '..', 'package.json');
    const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
    installedVersion = typeof version === 'string' ? version : null;
  } catch {
    installedVersion = null;
  }
  return installedVersion;
}

interface ConptyAgent {
  _useConpty?: boolean;
  _useConptyDll?: boolean;
  _innerPid?: number;
  readonly exitCode?: number;
  _getConsoleProcessList?: () => Promise<number[]>;
}

const LIST_TIMEOUT_MS = 5_000;

export function killPty(pty: IPty, deps: PtyKillDeps = {}): void {
  if ((deps.platform ?? process.platform) === 'win32') listConsoleSafely(pty, deps);
  pty.kill();
}

function listConsoleSafely(pty: IPty, deps: PtyKillDeps): void {
  const version = deps.nodePtyVersion !== undefined ? deps.nodePtyVersion : installedNodePtyVersion();
  if (!version || !HANDLED_NODE_PTY.test(version)) return;
  const agent = (pty as unknown as { _agent?: ConptyAgent })._agent;
  if (!agent || agent._useConpty !== true || agent._useConptyDll === true) return;
  if (typeof agent._getConsoleProcessList !== 'function' || typeof agent._innerPid !== 'number') return;
  agent._getConsoleProcessList = () => consoleProcesses(agent, agent._innerPid as number, deps);
}

function consoleProcesses(agent: ConptyAgent, shellPid: number, deps: PtyKillDeps): Promise<number[]> {
  if (agent.exitCode !== undefined) return Promise.resolve([]);
  return new Promise(resolve => {
    let helper: ChildProcess;
    try {
      helper = (deps.fork ?? nodeFork)(deps.listAgent ?? defaultListAgent(), [String(shellPid)], { silent: true });
      // No windowsHide: fork has none, and needs none. It starts process.execPath,
      // electron.exe in the app, a GUI program that opens no console window.
    } catch (err) {
      // kill() still closes the pseudo console, which ends what runs on it.
      console.warn(`[pty] could not list the processes on the console of ${shellPid}:`, err);
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      helper.kill();
      done(agent.exitCode === undefined ? [shellPid] : []);
    }, deps.timeoutMs ?? LIST_TIMEOUT_MS);
    let settled = false;
    const done = (list: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(list);
    };
    helper.on('message', message => {
      const list = (message as { consoleProcessList?: unknown } | null)?.consoleProcessList;
      done(Array.isArray(list) ? list.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0) : []);
    });
    // Read and dropped: its only words are the AttachConsole failure, which
    // means the shell has gone and there is nothing to list.
    helper.stdout?.resume();
    helper.stderr?.resume();
    helper.on('error', err => {
      console.warn(`[pty] the console list of ${shellPid} failed:`, err);
      done([]);
    });
    // After any message it sent: 'close' waits for its pipes and its channel.
    helper.on('close', () => done([]));
  });
}

function defaultListAgent(): string {
  return path.join(path.dirname(require.resolve('node-pty')), 'conpty_console_list_agent.js');
}
