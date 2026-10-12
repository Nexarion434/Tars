import { execFile } from 'child_process';

/**
 * Is the CLI that asks to register a session the one Tars launched in the
 * agent's terminal?
 *
 * A CLI run from inside an agent's terminal, a `claude -p` from its Bash tool,
 * inherits the agent's whole environment: CLAUDE_AGENT_ID, the terminal's
 * token and Tars's hooks. Its SessionStart named it the agent's session, its
 * Stop marked the agent done with its answer, and the real session's posts
 * were dropped as stale from then on (measured on 2026-10-13, claude 2.1.296).
 * Nothing in the environment can tell the two apart, since the nested CLI
 * inherits all of it; where the process sits can. Claude Code hands its hooks
 * CLAUDE_PID, its own pid (the nested claude's hook saw the nested pid), and
 * the CLI Tars launched is the terminal's process itself (its shell exec'd it:
 * the agent's claude had Tars as its parent) or that process's child (a shell
 * that ran a compound command). Anything deeper was started by something in
 * the terminal, not by Tars.
 *
 * Accepted as before, since there is nothing to compare: a post that names no
 * CLI (Gemini, a claude that does not set CLAUDE_PID), an agent with no
 * terminal Tars knows of, and on Windows any CLI but the terminal's own
 * process, whose parent there is no `ps` to read. Refused: a pid that is not
 * one, and a parent that cannot be read.
 */
export async function isTerminalsOwnCli(
  terminalPid: number | undefined,
  cliPid: unknown,
  deps: { platform?: NodeJS.Platform; parentPid?: (pid: number) => Promise<number | undefined> } = {},
): Promise<boolean> {
  const atOnce = ownCliAtOnce(terminalPid, cliPid, deps.platform);
  if (atOnce !== undefined) return atOnce;
  try {
    return (await (deps.parentPid ?? parentPid)(asPid(cliPid)!)) === terminalPid;
  } catch {
    return false;
  }
}

/**
 * isTerminalsOwnCli's answer when it needs no `ps`, undefined when it does:
 * the registration route stays synchronous for every CLI the terminal runs
 * itself, which is the agent's claude as Tars launches it.
 */
export function ownCliAtOnce(terminalPid: number | undefined, cliPid: unknown, platform: NodeJS.Platform = process.platform): boolean | undefined {
  if (cliPid === undefined || cliPid === null || cliPid === '') return true;
  const pid = asPid(cliPid);
  if (pid === undefined) return false;
  if (terminalPid === undefined) return true;
  if (pid === terminalPid) return true;
  if (platform === 'win32') return true;
  return undefined;
}

/** The largest pid any of the platforms Tars runs on hands out (Linux's pid_max ceiling, 2^22). */
const MAX_PID = 4_194_304;

function asPid(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9][0-9]{0,6}$/.test(text)) return undefined;
  const pid = Number(text);
  return pid <= MAX_PID ? pid : undefined;
}

/** A live process's parent pid, from `ps` (macOS and Linux); undefined when it is gone or cannot be read. */
export function parentPid(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const parent = error ? undefined : asPid(String(stdout).trim());
      resolve(parent);
    });
  });
}
