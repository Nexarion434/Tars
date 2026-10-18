import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A scheduled task of a key provider finds its key in ~/.tars-private (2.0.4).
 * The scripts read it with `jq` out of ~/.dorothy/app-settings.json, which no
 * longer holds one, and the bridge providers (Venice, a custom endpoint) with
 * `cat ~/.dorothy/api-token`, which is no longer there.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  K1. The script still reads a key out of app-settings.json or the old
 *      api-token, and the CLI starts with none.
 *  K2. The key is written into the script itself: scripts live in ~/.dorothy,
 *      every agent's --add-dir.
 *  K3. With no key in the private file, the CLI starts anyway, keyless, and
 *      falls back on whatever login the user's own Claude Code has, sending it
 *      to the vendor's URL; or it fails without a word in the task's log.
 *  K4. The key reaches the CLI some other way than the Bearer every key
 *      provider's endpoint takes (ANTHROPIC_AUTH_TOKEN), or ANTHROPIC_API_KEY
 *      inherited from the user's shell goes along with it.
 *  K5. A key with shell in it ($(...), a backtick) is run by the script.
 *  K6. A provider left out: every key provider's script is run here.
 */

import { getProvider } from '../../../electron/providers';
import { saveSettingsSplit, SECRETS_FILE } from '../../../electron/services/settings-secrets';
import { API_TOKEN_FILE, DATA_DIR } from '../../../electron/constants';
import type { AgentProvider, AppSettings } from '../../../electron/types';

const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;
const KEY = 'sk-test-0123456789';

/** Each key provider, and the settings field its scheduled key is. The bridges present Tars's own token. */
const CASES: Array<[AgentProvider, keyof AppSettings | 'api-token']> = [
  ['openrouter', 'openRouterApiKey'], ['deepseek', 'deepSeekApiKey'], ['mimo', 'openRouterApiKey'],
  ['moonshot', 'moonshotApiKey'], ['qwen', 'openRouterApiKey'], ['zhipu', 'zhipuApiKey'],
  ['minimax', 'minimaxApiKey'], ['nvidia', 'openRouterApiKey'], ['nous-portal', 'openRouterApiKey'],
  ['ollama-cloud', 'ollamaCloudApiKey'], ['venice', 'api-token'], ['custom-openai', 'api-token'],
];

let root: string;
const fakeCli = () => path.join(root, 'fake-claude');
const seen = () => path.join(root, 'seen');
const log = () => path.join(root, 'task.log');

function seed(field: string, value: string | null): void {
  fs.rmSync(SECRETS_FILE, { force: true });
  fs.rmSync(API_TOKEN_FILE, { force: true });
  if (field === 'api-token') {
    // A venice or custom endpoint key, so the provider builds its bridge's script.
    saveSettingsSplit({ veniceApiKey: 'v', customOpenAIApiKey: 'c', customOpenAIBaseUrl: 'https://x.example/v1' } as unknown as AppSettings);
    if (value !== null) { fs.mkdirSync(path.dirname(API_TOKEN_FILE), { recursive: true }); fs.writeFileSync(API_TOKEN_FILE, value); }
  } else {
    saveSettingsSplit((value === null ? {} : { [field]: value }) as unknown as AppSettings);
  }
}

function build(id: AgentProvider): string {
  return getProvider(id).buildScheduledScript!({
    binaryPath: fakeCli(), binaryDir: root, projectPath: root, prompt: 'do it', autonomous: false,
    mcpConfigPath: path.join(root, 'mcp.json'), logPath: log(), homeDir: os.homedir(),
  });
}

function runScript(script: string): number | null {
  const file = path.join(root, 'task.sh');
  fs.writeFileSync(file, script, { mode: 0o700 });
  return spawnSync('bash', [file], { env: { PATH: process.env.PATH, HOME: os.homedir(), ANTHROPIC_API_KEY: 'users-own-key' }, encoding: 'utf-8' }).status;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.homedir(), 'sched-'));
  fs.writeFileSync(fakeCli(), `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_API_KEY" "$ANTHROPIC_BASE_URL" > '${seen()}'\n`, { mode: 0o700 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

describe.skipIf(!HAS_BASH)('a scheduled task of a key provider, and its key', () => {
  it.each(CASES)('K1, K2, K4, K6. %s reads its key from the private folder and hands it as the Bearer', (id, field) => {
    seed(field, KEY);
    const script = build(id);
    expect(script).not.toContain(KEY);
    expect(script).not.toMatch(/\bjq\b[^\n]*(ApiKey|Token)/);
    expect(script).not.toMatch(/\.dorothy\/api-token|DATA_DIR[^\n]*api-token/);
    expect(runScript(script)).toBe(0);
    const [auth, apiKey] = fs.readFileSync(seen(), 'utf-8').split('\n');
    expect(auth).toBe(KEY);
    expect(apiKey).toBe('');
  });

  it.each(CASES)('K3. %s refuses to start without a key, and says so in its log', (id, field) => {
    seed(field, KEY);
    const script = build(id);
    seed(field, null);
    expect(runScript(script)).not.toBe(0);
    expect(fs.existsSync(seen())).toBe(false);
    expect(fs.readFileSync(log(), 'utf-8')).toMatch(/no key/i);
  });

  it('K5. a key with shell in it reaches the CLI as it is, and runs nothing', () => {
    const odd = 'k$(touch pwned)`touch pwned2`';
    seed('deepSeekApiKey', odd);
    expect(runScript(build('deepseek'))).toBe(0);
    expect(fs.readFileSync(seen(), 'utf-8').split('\n')[0]).toBe(odd);
    expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'pwned2'))).toBe(false);
  });
});
