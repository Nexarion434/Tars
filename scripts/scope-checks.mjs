#!/usr/bin/env node
/**
 * Decide whether this change can have moved a rendered surface, and run the
 * end to end suite only when it can.
 *
 * The suite starts a Next server, launches Electron and walks thirty five
 * surfaces: about three minutes, against a few seconds for both tsc passes and
 * forty five for the unit tests. Running it after a change that could not
 * possibly have altered a pixel is most of the cost of a review round for
 * nothing.
 *
 * The rule is an allowlist, not a denylist, and that direction is the whole
 * point: a path this file has never heard of runs the suite. Missing a visual
 * regression costs incomparably more than three minutes, so every doubt,
 * including a brand new directory nobody has classified yet, resolves towards
 * running.
 *
 * Note what is deliberately NOT on the allowlist. `electron/` is not, even
 * though its files are not the renderer: the suite boots the real application
 * against a seeded home directory, so what a surface displays comes through
 * real main process code. window-manager.ts decides how the window is created,
 * preload.ts is the renderer's whole contract, and the services behind Chat and
 * Usage decide what those pages have to show. An electron change absolutely
 * can move a screenshot, and has.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';

const run = promisify(execFile);

/**
 * Paths that cannot reach a rendered surface, whatever they contain.
 *
 * Each entry has to be defensible on its own: not "probably fine", but "there
 * is no path from this file to a pixel in the running app".
 */
const CANNOT_REACH_THE_RENDERER = [
  // Test code. Runs beside the app, never inside it.
  { prefix: '__tests__/', why: 'unit tests, not shipped into the app' },
  // Separate bundles, spawned as their own processes by the CLIs.
  { match: /^mcp-[^/]+\//, why: 'an MCP server bundle, a separate process' },
  // Shell hooks installed into the coding CLIs.
  { prefix: 'hooks/', why: 'shell hooks for the CLIs, outside the app' },
  // Build and development tooling, including this file.
  { prefix: 'scripts/', why: 'build and development tooling' },
  { prefix: '.github/', why: 'CI configuration' },
  // The marketing site is its own Next app.
  { prefix: 'landing/', why: 'the landing site, a separate app' },
  // Plugins for Hermes, installed by hand on the Hermes server; the app never loads them.
  { prefix: 'hermes-plugins/', why: 'a Hermes plugin, run by Hermes on its server' },
  // Prompt text handed to agents. Read by CLIs, never rendered.
  { match: /^electron\/resources\/.*\.md$/, why: 'agent prompt text, never rendered' },
  // Documentation.
  { match: /^[^/]+\.md$/, why: 'documentation' },
  // Named one by one rather than "any root dotfile". That rule was the only
  // one here resting on a category instead of a fact, and the category is not
  // true: a .postcssrc or a .browserslistrc is a build input that would change
  // every screenshot while looking like configuration. These do not build
  // anything, so anything else with a dot runs.
  { exact: '.gitignore', why: 'git configuration' },
  { exact: '.gitattributes', why: 'git configuration' },
  { exact: '.editorconfig', why: 'editor configuration' },
  { exact: '.nvmrc', why: 'a Node version pin read by the shell' },
  { exact: '.eslintignore', why: 'lint configuration' },
  { exact: '.prettierignore', why: 'formatter configuration' },
];

/** Where the suite lives, so a change to it always runs it. */
const ALWAYS_RUNS = ['e2e/', 'playwright.config.ts'];

/**
 * What a delegation between two CLIs goes through, which the CLI matrix
 * (e2e/cli-matrix.spec.ts, the Playwright project `matrix`) drives pair by
 * pair: 27 minutes for its two shells, out of the default suite since 19/10
 * (the orchestrator's decision), run at every release gate and here.
 *
 * Independent of the surfaces: an MCP server or a hook alone skips them, and
 * still breaks a pair. A list of what it depends on, unlike the surfaces' rule:
 * the release gate runs the matrix whatever this says.
 */
const REACHES_THE_MATRIX = [
  { prefix: 'electron/providers/', why: 'a provider: how its CLI starts, with its hooks and MCP servers' },
  { match: /^mcp-[^/]+\//, why: 'an MCP server, which delegate_task and send_message go through' },
  { prefix: 'hooks/', why: "a CLI's hooks, which say its turns and answers" },
  { prefix: 'mods/tars-state/', why: "the state mod, which says claude's turns" },
  { prefix: 'electron/services/acp/', why: 'the delegation over ACP' },
  { exact: 'electron/services/api-routes/agent-routes.ts', why: 'the delegation and message routes' },
  { exact: 'electron/services/api-routes/hooks-routes.ts', why: "the routes a CLI's hooks post to" },
  { exact: 'electron/services/api-routes/bus-routes.ts', why: 'the bus routes' },
  { match: /^electron\/services\/bus-[^/]+\.ts$/, why: 'the bus, which delivers between agents' },
  { exact: 'electron/handlers/bus-handlers.ts', why: "the bus's IPC" },
  { exact: 'electron/core/task-requests.ts', why: 'who asked an agent for its task' },
  { exact: 'electron/core/pty-manager.ts', why: 'what is typed into a terminal' },
  { exact: 'electron/core/agent-tokens.ts', why: "an agent's own token, its identity" },
  { exact: 'electron/services/mcp-orchestrator.ts', why: "the MCP servers written into each CLI's config" },
  { exact: 'electron/services/terminal-answer.ts', why: "a task's answer, read from its terminal" },
  { exact: 'electron/services/task-ledger.ts', why: 'the task ledger' },
  { exact: 'electron/services/usage-ledger.ts', why: 'the usage ledger' },
  { exact: 'electron/services/task-banner.ts', why: 'the task in hand and its queue' },
  { exact: 'electron/services/state-mod.ts', why: "what the state mod reports" },
  { match: /^e2e\/cli-matrix(\.live)?\.spec\.ts$/, why: 'the matrix itself' },
  { match: /^e2e\/fake-(clis|codex)\.mjs$/, why: "the matrix's stand-ins of the CLIs" },
  { exact: 'playwright.config.ts', why: 'the suite configuration' },
];

/** The rule a file matches, if any. */
function matching(rules, file) {
  return rules.find(rule => {
    if (rule.exact) return file === rule.exact;
    if (rule.prefix) return file.startsWith(rule.prefix);
    return rule.match.test(file);
  });
}

/**
 * Why each changed file does or does not force the suite.
 * @param {string[]} files
 */
export function decide(files) {
  const unique = [...new Set(files.filter(Boolean))].sort();
  if (unique.length === 0) {
    return {
      runE2E: true,
      reason: 'nothing to compare against, so nothing can be ruled out',
      forcing: [],
      skipped: [],
      runMatrix: true,
      matrixForcing: [],
    };
  }

  const forcing = [];
  const skipped = [];

  for (const file of unique) {
    if (ALWAYS_RUNS.some(p => file === p || file.startsWith(p))) {
      forcing.push({ file, why: 'the suite itself' });
      continue;
    }
    const safe = matching(CANNOT_REACH_THE_RENDERER, file);
    if (safe) skipped.push({ file, why: safe.why });
    else forcing.push({ file, why: 'can reach the renderer, or is unclassified' });
  }

  const matrixForcing = [];
  for (const file of unique) {
    const rule = matching(REACHES_THE_MATRIX, file);
    if (rule) matrixForcing.push({ file, why: rule.why });
  }

  return {
    runE2E: forcing.length > 0,
    reason: forcing.length > 0
      ? `${forcing.length} changed file(s) can reach a rendered surface`
      : `all ${skipped.length} changed file(s) are outside the running app`,
    forcing,
    skipped,
    runMatrix: matrixForcing.length > 0,
    matrixForcing,
  };
}

/** Where the trunk every branch merges into is fetched from. */
const REMOTE = 'origin';
const TRUNK = 'main';
/** A fetch that works takes a second or two; one that hangs must still end in a run. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * What git printed. A git call that fails throws, with what git said about it:
 * it is never read as an empty answer, which is what used to turn a base git
 * could not find into "nothing was committed on this branch".
 */
async function git(args, options = {}) {
  const { stdout } = await run('git', args, { cwd: process.cwd(), ...options });
  return stdout;
}

/** Why a git call failed, in one line. */
function gitSaid(err) {
  if (err.killed) return `no answer within ${FETCH_TIMEOUT_MS / 1000} s`;
  return String(err.stderr || err.message).trim().split('\n')[0];
}

/**
 * The commit this branch is compared against, or why there is none.
 *
 * The trunk as origin holds it now, fetched first. The base used to be the
 * local `main`, which is only as recent as its last pull. Measured on 17/09,
 * local main at d03aa41 and origin/main at 2f734fb: a branch with no change at
 * all counted 180 changed files and ran the suite. A stale base does worse than
 * waste the three minutes. A branch that undoes a renderer change the stale
 * base never had looks unchanged against it, and its suite was skipped. And a
 * base git cannot find (no local `main`, a mistyped SCOPE_BASE) read as an
 * empty diff, so only the uncommitted files were classified, and skipped too.
 *
 * Hence the rule: a base that cannot be fetched or found rules nothing out.
 * SCOPE_BASE still names another base, taken as it is and not fetched.
 */
async function resolveBase() {
  const explicit = process.env.SCOPE_BASE;
  if (!explicit) {
    try {
      // The refspec is spelled out so origin/main moves whatever this clone's
      // fetch configuration says, and a fetch that wants a password fails at
      // once instead of waiting at a prompt nobody may be there to answer.
      await git(['fetch', '--quiet', REMOTE, `+refs/heads/${TRUNK}:refs/remotes/${REMOTE}/${TRUNK}`], {
        timeout: FETCH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err) {
      return { problem: `could not fetch ${REMOTE}/${TRUNK}: ${gitSaid(err)}. A base that cannot be refreshed may be stale` };
    }
  }
  const ref = explicit || `refs/remotes/${REMOTE}/${TRUNK}`;
  try {
    const sha = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    return { sha, name: explicit ? `SCOPE_BASE=${explicit}, not fetched` : `${REMOTE}/${TRUNK}, fetched just now` };
  } catch (err) {
    return { problem: `${explicit ? `SCOPE_BASE=${explicit}` : `${REMOTE}/${TRUNK}`} is not a commit git can find: ${gitSaid(err)}` };
  }
}

/** Everything this branch changed, committed or not. Throws when git cannot say. */
async function changedFiles(base) {
  const out = [];

  // Committed on this branch, against the trunk it will merge into.
  //
  // --no-renames is load bearing. Git reports a rename as the new path alone,
  // so moving a component out of src/ into scripts/ or hooks/ looked like a
  // change to tooling and skipped the suite, while src/ had just lost a file
  // and the pages that imported it. Told not to detect renames, git reports
  // the deletion and the addition separately, and the deletion is the half
  // that matters.
  const merged = await git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
  out.push(...merged.split('\n'));
  // Plus anything still in the working tree, staged or not.
  const dirty = await git(['status', '--porcelain']);
  for (const line of dirty.split('\n')) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    // "XY old -> new" for a staged rename: both halves count, for the same
    // reason as above. Where it went from is as much a change as where it is.
    if (pathPart.includes(' -> ')) out.push(...pathPart.split(' -> '));
    else out.push(pathPart);
  }
  return out.map(f => f.trim()).filter(Boolean);
}

async function main() {
  const base = await resolveBase();
  if (base.problem) {
    console.log(`[scope] ${base.problem}.`);
    return runEverything();
  }
  console.log(`[scope] Base: ${base.sha.slice(0, 12)} (${base.name})`);

  let files;
  try {
    files = await changedFiles(base.sha);
  } catch (err) {
    console.log(`[scope] could not list the changes against ${base.sha.slice(0, 12)}: ${gitSaid(err)}.`);
    return runEverything();
  }
  const decision = decide(files);

  console.log(`[scope] ${files.length} changed file(s) against ${base.sha.slice(0, 12)}`);

  let code = 0;
  if (!decision.runE2E) {
    // Said out loud, at length, and naming every file. A run that quietly
    // skipped its slowest check reads afterwards as a run that passed it.
    console.log('[scope] SKIPPING the end to end suite.');
    console.log(`[scope] Why: ${decision.reason}.`);
    for (const { file, why } of decision.skipped) {
      console.log(`[scope]   ${file}: ${why}`);
    }
    console.log('[scope] No rendered surface was checked. Run `npm run e2e` to check them anyway.');
  } else {
    console.log(`[scope] Running the end to end suite: ${decision.reason}.`);
    for (const { file, why } of decision.forcing.slice(0, 12)) {
      console.log(`[scope]   ${file}: ${why}`);
    }
    if (decision.forcing.length > 12) {
      console.log(`[scope]   and ${decision.forcing.length - 12} more`);
    }
    code = await runSuite();
  }

  if (!decision.runMatrix) {
    console.log('[scope] Leaving the CLI matrix out: no changed file is on a delegation\'s way. Run `npm run e2e:matrix` to run it anyway.');
    return code;
  }
  console.log(`[scope] Running the CLI matrix: ${decision.matrixForcing.length} changed file(s) on a delegation's way.`);
  for (const { file, why } of decision.matrixForcing.slice(0, 12)) {
    console.log(`[scope]   ${file}: ${why}`);
  }
  if (decision.matrixForcing.length > 12) {
    console.log(`[scope]   and ${decision.matrixForcing.length - 12} more`);
  }
  return worst(code, await runMatrix());
}

/** A failure anywhere fails the whole run. */
function worst(...codes) {
  return codes.find(code => code !== 0) ?? 0;
}

/** Nothing to compare against, so nothing is ruled out. The line above it says why. */
async function runEverything() {
  console.log('[scope] Nothing can be ruled out: running the whole end to end suite, then the CLI matrix.');
  return worst(await runSuite(), await runMatrix());
}

function runSuite() {
  return playwright(['test'], process.env);
}

/** The CLI matrix, its own project: there only with E2E_MATRIX=1 (playwright.config.ts). */
function runMatrix() {
  return playwright(['test', '--project=matrix'], { ...process.env, E2E_MATRIX: '1' });
}

function playwright(args, env) {
  const npx = npmCommand('npx', ['playwright', ...args]);
  const child = execFile(npx.command, npx.args, { cwd: process.cwd(), env });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return new Promise(resolve => child.on('close', code => resolve(code ?? 1)));
}

// Only when run as a command, so the decision above can be imported and tested.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => process.exit(code)).catch(async err => {
    // Runs the suite it announces. It used to announce it and exit 1 with nothing run.
    console.error('[scope] could not decide, running everything:', err);
    process.exit(worst(await runSuite(), await runMatrix()));
  });
}
