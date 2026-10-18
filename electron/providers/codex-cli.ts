import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execCliSync } from './cli-exec';
import { trustsTooMuch } from '../utils/trust-too-much';
import type { AgentEffort } from '../types';

/**
 * What Tars reads from codex itself before it starts it: the flags the installed codex has, the models the
 * account has, and the efforts each of them takes. Measured on codex-cli 0.163.0 (standalone install, ChatGPT
 * account). See codex-cli.test.ts for each way this goes wrong.
 */

/** Where codex keeps its config, its sessions and its model cache: CODEX_HOME, else ~/.codex, as codex reads it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** The flags a codex `--help` lists. */
export function codexFlagsFromHelp(help: string): Set<string> {
  return new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

const flagsByBinary = new Map<string, Set<string>>();

function flagsOf(binaryPath: string): Set<string> {
  let key = binaryPath;
  try {
    const real = fs.realpathSync(binaryPath);
    const stat = fs.statSync(real);
    key = `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch { /* asked by its name: on the PATH, or not there at all */ }
  let flags = flagsByBinary.get(key);
  if (!flags) {
    try {
      // On the main thread, once per binary: codex answers --help in tens of
      // milliseconds, and one that hangs is given up on quickly.
      flags = codexFlagsFromHelp(String(execCliSync(binaryPath, ['--help'], { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch {
      flags = new Set();
    }
    flagsByBinary.set(key, flags);
  }
  return flags;
}

/**
 * Whether the codex at `binaryPath` has a flag, from its own `--help`, asked when a flag is first asked about (only
 * auto needs one), and once per binary (its path, size and time of change: an update is asked again). A codex that
 * cannot be asked has none of the flags this checks: it is handed the stable ones only.
 */
export function codexAccepts(binaryPath: string): (flag: string) => boolean {
  let known: Set<string> | undefined;
  return (flag: string) => (known ??= flagsOf(binaryPath)).has(flag);
}

/**
 * The flags a Tars permission mode becomes for codex. Never `--full-auto` (0.163 refuses it, exit 2), nor an
 * approval policy that waits for a person, whom nobody is in an agent's terminal:
 * - auto: codex's automatic review of each approval (`--approve-for-me`, 0.163) where the installed codex has it,
 *   else no approval asked inside the workspace sandbox (`-a never -s workspace-write`, the stable flags);
 * - bypass: codex's own bypass;
 * - normal: nothing, so codex asks as the user set it to (plan is refused for codex before it gets here).
 */
export function codexPermissionArgs(mode: string | undefined, accepts: (flag: string) => boolean): string[] {
  if (mode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'auto') {
    return accepts('--approve-for-me') ? ['--approve-for-me'] : ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'];
  }
  return [];
}

/** A model of the account, as codex lists it. */
export interface CodexModel {
  id: string;
  name: string;
  description: string;
  defaultEffort?: string;
  /** The efforts the model takes, in codex's words. */
  efforts: string[];
  contextWindow?: number;
}

/**
 * The models in codex's own cache (models_cache.json, which codex fetches for the account it is signed in with):
 * those it lists (`visibility: list`), in its order (`priority`). Anything written otherwise is left out, never a
 * crash.
 */
export function codexModelsFrom(cache: unknown): CodexModel[] {
  const models = cache && typeof cache === 'object' ? (cache as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  const listed: Array<CodexModel & { priority: number }> = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const entry = m as Record<string, unknown>;
    if (typeof entry.slug !== 'string' || !entry.slug) continue;
    if (entry.visibility !== undefined && entry.visibility !== 'list') continue;
    const efforts = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
        .map(level => (level && typeof level === 'object' ? (level as { effort?: unknown }).effort : level))
        .filter((effort): effort is string => typeof effort === 'string')
      : [];
    listed.push({
      id: entry.slug,
      name: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.slug,
      description: typeof entry.description === 'string' ? entry.description : '',
      ...(typeof entry.default_reasoning_level === 'string' ? { defaultEffort: entry.default_reasoning_level } : {}),
      efforts,
      ...(typeof entry.context_window === 'number' ? { contextWindow: entry.context_window } : {}),
      priority: typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  return listed.sort((a, b) => a.priority - b.priority).map(({ priority: _priority, ...model }) => model);
}

/** The account's models from the cache codex keeps in its home; none when codex has not written one. */
export function readCodexModels(home: string = codexHome()): CodexModel[] {
  try {
    return codexModelsFrom(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf-8')));
  } catch {
    return [];
  }
}

const EFFORT_ORDER: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort as codex takes it, `-c model_reasoning_effort=<level>`. At the level asked when the model takes it,
 * else the nearest level below that it takes (codex refuses a turn at a level the model has not); as asked when
 * codex's list does not name the model. Nothing for no effort, or for a word that is not one of Tars's levels.
 */
export function codexEffortArgs(effort: string | undefined, model: string | undefined, models: CodexModel[]): string[] {
  if (!effort || !EFFORT_ORDER.includes(effort as AgentEffort)) return [];
  const takes = model ? models.find(m => m.id === model)?.efforts : undefined;
  let level = effort;
  if (takes && takes.length > 0 && !takes.includes(effort)) {
    const below = EFFORT_ORDER.slice(0, EFFORT_ORDER.indexOf(effort as AgentEffort)).reverse().find(e => takes.includes(e));
    level = below ?? EFFORT_ORDER.find(e => takes.includes(e)) ?? effort;
  }
  return ['-c', `model_reasoning_effort=${level}`];
}

/**
 * The agent's folder trusted in codex's config before its codex starts, as ensureProjectTrusted does for Claude Code.
 * Measured on codex-cli 0.163.0: in a folder its config does not trust, codex first asks "Trust this folder?",
 * writes no session and does nothing until someone answers, which nobody does in an agent's terminal; with
 * `[projects."<folder>"] trust_level = "trusted"` the same launch ran its turn. Under the folder's real path, the
 * one codex records (its session's cwd). A choice already in the config, trusted or not, is the user's and is left
 * as it is; a folder that would trust every folder below it is refused (utils/trust-too-much.ts), and codex asks.
 */
export function ensureCodexProjectTrusted(projectPath: string, home: string = codexHome()): 'written' | 'already' | 'refused' | 'failed' {
  if (!projectPath || trustsTooMuch(projectPath)) return 'refused';
  let real: string;
  try { real = fs.realpathSync(projectPath); } catch { return 'failed'; }
  const file = path.join(home, 'config.toml');
  let content = '';
  try { content = fs.readFileSync(file, 'utf-8'); } catch { /* none yet */ }
  const header = `[projects.${JSON.stringify(real).replace(/\u007f/g, '\\u007F')}]`;
  if (content.includes(header)) return 'already';
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`);
    return 'written';
  } catch (err) {
    console.warn(`[codex] ${real} not trusted in ${file}:`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}
