import * as fs from 'fs';
import * as path from 'path';

/**
 * How Tars's hooks are started by the CLIs that run them, and how their
 * entries are kept in the CLIs' settings files.
 *
 * Decision D1 of the Windows port: on win32 every hook is the one Node runner,
 * `node "<abs>/hooks/tars-hook.mjs" <event>` (and `statusline.mjs` for the
 * status line), because the .sh scripts cannot run there (audit A7 to A15). On
 * darwin and linux nothing here is used: the providers keep writing the .sh
 * paths they always wrote.
 *
 * The one place that decides. It belongs in electron/platform/ once that layer
 * is merged; it is a file of its own so that move is a rename.
 */

/** Whether this platform's CLIs run the Node runner instead of the .sh hooks. */
export function usesNodeHooks(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * The shell-form command a CLI runs for a Node hook: `node "<script>" <args>`.
 *
 * Shell form, not Claude Code's exec form (`command` + `args`): an older
 * claude that predates `args` would run bare `node` and feed it the hook's
 * JSON as a program. Shell form runs everywhere, and it is read by two
 * shells: Git Bash (Claude Code on Windows when Git is installed) and Windows
 * PowerShell (Claude Code without Git Bash, and Gemini CLI always, through
 * `powershell.exe -NoProfile -Command`). So:
 *  - forward slashes: bash would eat the backslashes of an unquoted path, and
 *    turns `\\server` into `\server` even inside double quotes; Node takes
 *    `C:/...` and `//server/share/...` as they are;
 *  - double quotes, which both shells read the same way unless the path holds
 *    `$` or a backtick (expanded by both, escaped differently by each); then
 *    single quotes, which both read literally unless the path holds a `'`;
 *  - a path with both is refused, loudly, rather than wired to fail.
 * The arguments are Tars's own event names, never user input.
 */
export function nodeHookCommand(script: string, ...args: string[]): string {
  const p = script.replace(/\\/g, '/');
  let quoted: string;
  if (!/[$`"]/.test(p)) quoted = `"${p}"`;
  else if (!p.includes("'")) quoted = `'${p}'`;
  else throw new Error(`The hooks path ${script} cannot be quoted for both Git Bash and PowerShell: it holds a quote and a $ or backtick.`);
  for (const arg of args) {
    if (!/^[A-Za-z0-9/_.-]+$/.test(arg)) throw new Error(`Not a hook event name: ${arg}`);
  }
  return ['node', quoted, ...args].join(' ');
}

/**
 * A matcher for the .sh command a previous Tars wrote, `<hooksDir>/<rel>`:
 * the file name under a `hooks` folder, either separator, so a user's own
 * `my-on-stop.sh` is not taken for Tars's.
 */
export function legacyShCommand(rel: string): (command: string) => boolean {
  const escaped = rel.split('/').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  const re = new RegExp(`(^|[\\\\/])hooks[\\\\/]${escaped}$`);
  return command => re.test(command.trim());
}

/** A Node hook command Tars wrote, from any checkout: which script it runs and with what event. */
export function parseNodeHookCommand(command: unknown): { script: string; event?: string } | undefined {
  if (typeof command !== 'string') return undefined;
  const m = /^node\s+(["'])(.+?)\1(?:\s+(\S+))?\s*$/.exec(command.trim());
  if (!m) return undefined;
  return { script: m[2], event: m[3] };
}

type Hook = { type?: string; command?: string; timeout?: number; [key: string]: unknown };
type Entry = { matcher?: string; hooks?: Hook[]; [key: string]: unknown };
export type HookTable = Record<string, Entry[] | undefined>;

export type NodeHookSpec = {
  /** The CLI's event name, the key in `hooks`. */
  type: string;
  /** The runner's event argument, the .sh path under hooks/ without `.sh`. */
  event: string;
  matcher?: string;
  /** Is this command one Tars wrote for this event in the .sh era? */
  isLegacy: (command: string) => boolean;
  /** Other keys where Tars once wired this script, to be cleared (Gemini's UserPromptSubmit). */
  formerTypes?: string[];
};

/**
 * Put one Node-runner entry per event into a CLI's `hooks` table.
 *
 * A hook is Tars's when its command runs tars-hook.mjs with this event (from
 * this checkout or another) or is the .sh a previous Tars wrote for it. The
 * first such hook keeps its place, its matcher and its timeout, and gets the
 * command of this checkout; every other one is removed (the .sh copies the
 * old Gemini probe appended at each start, audit A11), with its entry when it
 * held nothing else. Hooks that are not Tars's are never touched. Returns
 * whether anything changed, so a second run writes nothing.
 */
export function mergeNodeHooks(hooks: HookTable, specs: NodeHookSpec[], hooksDir: string, timeout: number): boolean {
  const runner = path.join(hooksDir, 'tars-hook.mjs');
  if (!fs.existsSync(runner)) return false;
  let changed = false;

  const isOurs = (spec: NodeHookSpec, hook: Hook | undefined): boolean => {
    const command = hook?.command;
    if (typeof command !== 'string') return false;
    const parsed = parseNodeHookCommand(command);
    if (parsed && /(^|\/)tars-hook\.mjs$/.test(parsed.script.replace(/\\/g, '/')) && parsed.event === spec.event) return true;
    return spec.isLegacy(command);
  };

  /** Remove Tars's hooks for this spec from one key, keeping the first when asked. Returns the kept one. */
  const sweep = (type: string, spec: NodeHookSpec, keepFirst: boolean): Hook | undefined => {
    const entries = hooks[type];
    if (!Array.isArray(entries)) return undefined;
    let kept: Hook | undefined;
    const next: Entry[] = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) { next.push(entry); continue; }
      const remaining = entry.hooks.filter(hook => {
        if (!isOurs(spec, hook)) return true;
        if (keepFirst && !kept) { kept = hook; return true; }
        changed = true;
        return false;
      });
      if (remaining.length === entry.hooks.length) next.push(entry);
      else if (remaining.length > 0) next.push({ ...entry, hooks: remaining });
    }
    if (next.length !== entries.length || next.some((e, i) => e !== entries[i])) {
      if (next.length === 0) delete hooks[type];
      else hooks[type] = next;
    }
    return kept;
  };

  for (const spec of specs) {
    const command = nodeHookCommand(runner, spec.event);
    const kept = sweep(spec.type, spec, true);
    if (kept) {
      if (kept.command !== command) {
        kept.command = command;
        changed = true;
      }
    } else {
      const entry: Entry = { hooks: [{ type: 'command', command, timeout }] };
      if (spec.matcher) entry.matcher = spec.matcher;
      hooks[spec.type] = [...(hooks[spec.type] ?? []), entry];
      changed = true;
    }
    for (const former of spec.formerTypes ?? []) sweep(former, spec, false);
  }
  return changed;
}
