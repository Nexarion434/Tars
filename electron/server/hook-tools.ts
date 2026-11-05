import * as fs from 'fs';
import * as path from 'path';

/**
 * The tools a Tars server's Claude agents need for their hooks
 * (hooks/session-start.sh, on-stop.sh and the others run under bash, read
 * the CLI's JSON with jq and post it with curl). Measured on the VPS on
 * 2026-11-04: its image had no jq, so every SessionStart posted an empty
 * session_id and was refused, an agent read as still starting for 3 minutes,
 * an orchestrator's delegation was refused meanwhile, and no task's end was
 * told. Said by `status --json` (`missingTools`) and in the server's log at
 * boot, never guessed around.
 */
export const HOOK_TOOLS = ['bash', 'jq', 'curl'] as const;

/** Whether `tool` is an executable file in one of the PATH's folders. */
export function onPath(tool: string, pathValue: string = process.env.PATH ?? ''): boolean {
  return pathValue.split(path.delimiter).filter(Boolean).some(dir => {
    const file = path.join(dir, tool);
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function missingHookTools(found: (tool: string) => boolean = tool => onPath(tool)): string[] {
  return HOOK_TOOLS.filter(tool => !found(tool));
}

/** What the server says when one is missing: what breaks, and how to install them. */
export function hookToolsSentence(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `${names} ${missing.length === 1 ? 'is' : 'are'} missing on this server: its Claude agents' hooks cannot tell Tars when a session starts or a task ends, so a delegation waits and is refused. Install ${missing.length === 1 ? 'it' : 'them'} in the image (Debian: apt-get install -y ${missing.join(' ')}).`;
}
