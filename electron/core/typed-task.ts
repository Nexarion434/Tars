import type * as pty from 'node-pty';
import { cliRunningIn } from './agent-pty';
import { writeProgrammaticInput, type WriteOutcome } from './pty-manager';
import type { CLIProvider, InteractiveCommandParams } from '../providers/cli-provider';

/**
 * A task typed into a CLI that takes none on its command line (amp: its only
 * way is `-x`, which runs once and exits, and its TUI takes a first message
 * from its input alone). The agent's permanent session is started bare, and
 * the task goes in like any message, once the CLI runs in its terminal (typed
 * earlier, it would reach the shell, which runs it as a command) and its
 * screen has had time to come up (keys sent to a TUI still starting are lost).
 */

/** How long a TUI is given to draw itself once its process runs. */
export const TUI_SETTLE_MS = 2_000;
/** How long a CLI is given to start at all, as a launch is (agent-launch.ts, CLI_BOOT_MS). */
export const CLI_START_MS = 15_000;

export async function typeTaskWhenUp(
  ptyProcess: pty.IPty,
  task: string,
  opts: { settleMs?: number; maxMs?: number; stepMs?: number } = {},
): Promise<WriteOutcome | 'never-up'> {
  const step = opts.stepMs ?? 200;
  const until = Date.now() + (opts.maxMs ?? CLI_START_MS);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!cliRunningIn(ptyProcess)) {
    if (Date.now() >= until) return 'never-up';
    await sleep(step);
  }
  // Up, then given its settle time, and still up at its end.
  const settled = Date.now() + (opts.settleMs ?? TUI_SETTLE_MS);
  while (Date.now() < settled) {
    await sleep(Math.min(step, settled - Date.now()));
    if (!cliRunningIn(ptyProcess)) return 'never-up';
  }
  return writeProgrammaticInput(ptyProcess, task, true);
}

/**
 * Every launch with a task calls this once its CLI's terminal is known: for a
 * CLI whose command carries no task (taskTypedAfterLaunch), the task is typed
 * in once it runs; for every other CLI, nothing.
 */
export function typeLaunchTask(
  provider: Pick<CLIProvider, 'id' | 'taskTypedAfterLaunch' | 'typedTask'>,
  ptyProcess: pty.IPty,
  params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>,
): void {
  if (!provider.taskTypedAfterLaunch) return;
  const text = provider.typedTask?.(params) ?? '';
  if (!text) return;
  void typeTaskWhenUp(ptyProcess, text).then((outcome) => {
    if (outcome === 'never-up' || outcome === 'refused') console.warn(`[launch] ${provider.id}: the task was not typed in (${outcome})`);
  });
}
