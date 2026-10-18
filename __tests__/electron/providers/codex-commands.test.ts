import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The command lines Tars starts codex with, in every builder: an agent's terminal, a scheduled run and a one-shot
 * (2.0.4). Measured on codex-cli 0.163.0.
 *
 * The ways it fails:
 * 1. `--full-auto` anywhere: 0.163 refuses it ("unexpected argument", exit 2), so every codex agent in auto or bypass
 *    died at launch, and so did every scheduled run.
 * 2. `codex exec`'s own options before `exec`: `codex --json exec` is refused too (exit 2). Its options go after it.
 * 3. The effort dropped by a builder (codex-provider.ts had none: `"reasoning_effort": null` in codex's own log for an
 *    agent set to low), or the model.
 * 4. A permission mode turned into a flag the installed codex does not have, which is the same exit 2
 *    (codex-cli.test.ts says which flags each mode becomes; these say every builder uses them).
 * 5. A prompt that leaves its quotes: a task is user text, and the line is run by a shell or read back into argv.
 */

import { CodexProvider } from '../../../electron/providers/codex-provider';

const HELP_0163 = `Codex CLI
      --approve-for-me
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>`;

let codex016 = '';
const nowhere = path.join(os.tmpdir(), 'no-such-codex-for-tars-tests');
const provider = new CodexProvider();
const PROMPT = "fix it, it's \"quoted\"";

/** The argv a POSIX shell makes of one of these lines: single and double quotes, and backslash-escaped quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue; }
    if (quote === '"') { if (ch === '"') quote = null; else if (ch === '\\' && i + 1 < line.length) cur += line[++i]; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; had = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; had = true; continue; }
    if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-0163-'));
  codex016 = path.join(dir, 'codex');
  fs.writeFileSync(codex016, `#!/bin/sh\ncat <<'EOF'\n${HELP_0163}\nEOF\n`, { mode: 0o755 });
});

describe("an agent's terminal", () => {
  it('auto: the automatic review on a codex that has it; bypass: its own bypass; never --full-auto', () => {
    const auto = words(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, permissionMode: 'auto' }));
    expect(auto).toContain('--approve-for-me');
    const bypass = words(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, permissionMode: 'bypass' }));
    expect(bypass).toContain('--dangerously-bypass-approvals-and-sandbox');
    const older = words(provider.buildInteractiveCommand({ binaryPath: nowhere, prompt: PROMPT, permissionMode: 'auto' }));
    expect(older).toEqual(expect.arrayContaining(['--ask-for-approval', 'never', '--sandbox', 'workspace-write']));
    for (const argv of [auto, bypass, older]) expect(argv).not.toContain('--full-auto');
  });

  it('the model and the effort, the prompt last and whole', () => {
    const argv = words(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, model: 'gpt-6-luna', effort: 'low', permissionMode: 'normal' }));
    expect(argv[0]).toBe(codex016);
    expect(argv.slice(1, 3)).toEqual(['--model', 'gpt-6-luna']);
    expect(argv).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=low']));
    expect(argv[argv.length - 1]).toBe(PROMPT);
    expect(argv).not.toContain('--approve-for-me');
  });
});

describe('a scheduled run and a one-shot', () => {
  it("put codex exec's own options after exec, with the permission, the model and the effort", () => {
    const scheduled = words(provider.buildScheduledCommand({ binaryPath: codex016, prompt: PROMPT, autonomous: true, outputFormat: 'stream-json', model: 'gpt-6-luna', effort: 'low' }));
    expect(scheduled.slice(0, 2)).toEqual([codex016, 'exec']);
    expect(scheduled).toEqual(expect.arrayContaining(['--json', '--approve-for-me', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=low']));
    expect(scheduled[scheduled.length - 1]).toBe(PROMPT);
    expect(scheduled).not.toContain('--full-auto');

    const oneShot = words(provider.buildOneShotCommand({ binaryPath: codex016, prompt: PROMPT, model: 'gpt-6-luna', effort: 'medium' }));
    expect(oneShot.slice(0, 2)).toEqual([codex016, 'exec']);
    expect(oneShot).toEqual(expect.arrayContaining(['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium']));
    expect(oneShot[oneShot.length - 1]).toBe(PROMPT);
  });

  it("a scheduled script's codex line, the same way", () => {
    const script = provider.buildScheduledScript({
      binaryPath: codex016, binaryDir: path.dirname(codex016), projectPath: '/tmp/project', prompt: PROMPT, autonomous: true,
      mcpConfigPath: '', logPath: '/tmp/log', homeDir: '/tmp/home', model: 'gpt-6-luna', effort: 'high',
    });
    const line = script.split('\n').find(l => l.includes(codex016) && l.includes('exec'))!;
    expect(line, script).toBeTruthy();
    const argv = words(line.replace(/\s*>>.*$/, ''));
    expect(argv.slice(0, 2)).toEqual([codex016, 'exec']);
    expect(argv).toEqual(expect.arrayContaining(['--json', '--approve-for-me', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=high']));
    expect(argv[argv.length - 1]).toBe(PROMPT);
    expect(script).not.toContain('--full-auto');
  });
});
