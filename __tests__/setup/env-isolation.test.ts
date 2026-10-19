import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/**
 * What Tars hands its agents never reaches the code under test, and the
 * suite's own opt-ins still do.
 *
 * How it can fail, written on 2026-10-19 before the fix:
 * 1. A variable Tars puts in an agent's terminal outside the product's
 *    prefixes (TARS_CLAUDE_ACCOUNT, TARS_CHATS_READ, TARS_INSTANCE_ID) is still
 *    set when a test file starts, since the suite was run from that terminal:
 *    QA and every agent run it there. acp-account-env.test.ts read
 *    TARS_CLAUDE_ACCOUNT=default and failed under every Tars agent, and passed
 *    in a plain shell.
 * 2. The suite's own opt-ins, named TARS_ too (TARS_STRESS, TARS_REAL_CLAUDE,
 *    TARS_HERMES_TREE, TARS_HERMES_PYTHON), go with them, and the tests they
 *    enable are skipped without a word.
 */

const FIXTURES = '__tests__/setup/fixtures/tmpdir-guard';
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

describe('the environment a test file starts in', () => {
  it('1, 2. holds none of what Tars hands its agents, and every opt-in of the suite\'s own', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
    // The child is a run of its own, not a worker of this one, started from an agent's terminal.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', 'env-from-tars'], {
      cwd: process.cwd(),
      env: {
        ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        TARS_CLAUDE_ACCOUNT: 'default', TARS_CHATS_READ: '1', TARS_INSTANCE_ID: 'an-agent-s-tars',
        TARS_STRESS: 'kept', TARS_REAL_CLAUDE: 'kept', TARS_HERMES_TREE: 'kept', TARS_HERMES_PYTHON: 'kept',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = stripVTControlCharacters(`${child.stdout}${child.stderr}`);

    expect(output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(child.status, output).toBe(0);
  }, 90_000);
});
