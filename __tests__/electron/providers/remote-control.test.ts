import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { argvReached, writeArgvPrinter } from './argv-reached';

/**
 * Remote Control (Nicolas, 2026-10-09): with the switch on, each Claude agent
 * starts as `claude --remote-control <its name>`, so the session shows in the
 * Claude app on his phone under the agent's name, and he can follow and drive
 * it there. Measured on this PC with Claude Code 2.1.284: the session connects
 * at once ("/remote-control is active"), with no question asked first.
 *
 * What can go wrong, each checked below, read the way the CLI reads it (a real
 * shell into a binary that prints its argv; on Windows, Tars's own launch):
 *
 * 1. The switch off: the command carries no `--remote-control` at all.
 * 2. `--remote-control [name]` takes an optional value: the name must be the
 *    argument right after it, and the task must stay the CLI's prompt, never
 *    taken as the name nor the name as the task.
 * 3. A name with a quote, spaces, `$` or a backtick reaches the CLI as typed,
 *    as one argument, and runs nothing.
 * 4. A name opening with a dash would be read as an option the CLI does not
 *    know, and it would refuse to start: the leading dashes are left out.
 * 5. A line break, a control or a format character (bidi, zero width) in the
 *    name: it is a session's title in a list, so one plain line.
 * 6. A name with nothing left once cleaned: a title still, "Tars agent".
 * 7. A name of hundreds of characters: cut to 80.
 * 8. The thirteen providers that run the claude binary against another API
 *    (an API key, ANTHROPIC_BASE_URL): Remote Control needs a claude.ai login,
 *    so they never pass it, switch on or not.
 * 9. A resumed conversation: `--resume <id>` keeps its id with the switch on.
 * Which agents the launchers ask it for (remoteControlName), found in review:
 * 10. A local agent (Tasmania) runs the Claude provider against a model on
 *    this machine, still signed in to claude.ai: with the flag its session,
 *    project code included, would be kept on Anthropic's servers. Never.
 * 11. An agent with no name, switch on: still asked for, under "Tars agent".
 * 12. The switch off, or absent from the settings: never asked for.
 * The project in the title (Nicolas, 2026-10-09, seeing them on his phone):
 * 13. "Revue finale" alone says nothing of where it works: the title is the
 *    project's folder name, then the agent's, "Allcazz · Revue finale".
 * 14. A name that already says its project ("Agent on Allcazz") is not said
 *    twice, whatever the case.
 * 15. An agent with no name: the project's name alone.
 * 16. A project folder given with a trailing separator still names it.
 * Found in the security review:
 * 17. A name or project that is not text (the API stores what it is sent):
 *    the agent must still start, under what is left.
 * 18. A double quote or a backslash in the name (Windows builds its command
 *    line with them): one argument still, and no option after it.
 */

let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

const OTHER_APIS = [
  'custom-openai', 'deepseek', 'mimo', 'minimax', 'moonshot', 'nous-portal',
  'nvidia', 'ollama', 'ollama-cloud', 'openrouter', 'qwen', 'venice', 'zhipu',
];
const TASK = 'Rebase onto main and say what fell';

async function provider(id: string) {
  const { getAllProviders } = await import('../../../electron/providers');
  const found = getAllProviders().find(p => p.id === id);
  expect(found, `${id} is not a provider any more`).toBeDefined();
  return found!;
}

function argvFor(command: string): string[] {
  return argvReached(command, tmpDir);
}

/** What follows `--remote-control`, before `--`: the name, or undefined when it is absent or given no value. */
function remoteControlOf(argv: string[]): { present: boolean; name?: string } {
  const end = argv.indexOf('--');
  const options = end === -1 ? argv : argv.slice(0, end);
  const at = options.indexOf('--remote-control');
  if (at === -1) return { present: false };
  const next = options[at + 1];
  return { present: true, name: next !== undefined && !next.startsWith('-') ? next : undefined };
}

/** The prompt the CLI receives: what follows `--`. */
const promptOf = (argv: string[]) => argv.slice(argv.indexOf('--') + 1);

async function launch(id: string, remoteControl: string | undefined, extra: Record<string, unknown> = {}) {
  const binaryPath = writeArgvPrinter(path.join(tmpDir, 'claude-argv'));
  const command = (await provider(id)).buildInteractiveCommand({ binaryPath, prompt: TASK, permissionMode: 'normal', remoteControl, ...extra });
  return argvFor(command);
}

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-control-'));
  fs.mkdirSync(path.join(tmpDir, '.dorothy'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a Claude agent reachable from the Claude apps', () => {
  it('1. the switch off: no --remote-control', async () => {
    const argv = await launch('claude', undefined);
    expect(remoteControlOf(argv).present).toBe(false);
    expect(promptOf(argv)).toEqual([TASK]);
  });

  it('2. the switch on: the agent\'s name right after the flag, and the task still the prompt', async () => {
    const argv = await launch('claude', 'Build the landing');
    expect(remoteControlOf(argv)).toEqual({ present: true, name: 'Build the landing' });
    expect(promptOf(argv)).toEqual([TASK]);
  });

  it('3. a name with a quote, spaces, $ and a backtick arrives as typed, and runs nothing', async () => {
    const name = "Ana's fix $(touch owned) `touch owned2` 100%";
    const argv = await launch('claude', name);
    expect(remoteControlOf(argv)).toEqual({ present: true, name });
    expect(promptOf(argv)).toEqual([TASK]);
    expect(fs.existsSync(path.join(tmpDir, 'owned'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'owned'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'owned2'))).toBe(false);
  });

  it('4. a name opening with dashes loses them, so the CLI never reads it as an option', async () => {
    expect(remoteControlOf(await launch('claude', '--dangerously-skip-permissions'))).toEqual({ present: true, name: 'dangerously-skip-permissions' });
    expect(remoteControlOf(await launch('claude', ' - notes'))).toEqual({ present: true, name: 'notes' });
  });

  it('5. a line break, controls and format characters leave one plain line', async () => {
    const argv = await launch('claude', 'first\nsecond\u0007 \u202Ethird\u200B');
    expect(remoteControlOf(argv)).toEqual({ present: true, name: 'first second third' });
  });

  it('6. a name with nothing left is still a title', async () => {
    expect(remoteControlOf(await launch('claude', '  --\u200B  '))).toEqual({ present: true, name: 'Tars agent' });
    expect(remoteControlOf(await launch('claude', ''))).toEqual({ present: true, name: 'Tars agent' });
  });

  it('7. a long name is cut to 80 characters', async () => {
    const { name } = remoteControlOf(await launch('claude', 'x'.repeat(500)));
    expect(name).toBe('x'.repeat(80));
  });

  it('9. a resumed conversation keeps its id beside it', async () => {
    const binaryPath = writeArgvPrinter(path.join(tmpDir, 'claude-argv'));
    const command = (await provider('claude')).buildInteractiveCommand({
      binaryPath, prompt: TASK, permissionMode: 'normal', remoteControl: 'Resumed', resumeSessionId: '0b3c2a1e-1111-4222-8333-944455556666',
    });
    const argv = argvFor(command);
    expect(argv[argv.indexOf('--resume') + 1]).toBe('0b3c2a1e-1111-4222-8333-944455556666');
    expect(remoteControlOf(argv)).toEqual({ present: true, name: 'Resumed' });
  });

  it('10. a local agent (Tasmania) is never asked for it, nor any provider but Claude Code', async () => {
    const { remoteControlName } = await import('../../../electron/providers/cli-provider');
    const on = { remoteControlEnabled: true };
    expect(remoteControlName(on, { name: 'On a local model', provider: 'local' })).toBeUndefined();
    for (const provider of [...OTHER_APIS, 'codex', 'gemini', 'grok', 'opencode', 'pi', 'amp']) {
      expect(remoteControlName(on, { name: 'Elsewhere', provider }), provider).toBeUndefined();
    }
    expect(remoteControlName(on, { name: 'Claude', provider: 'claude' })).toBe('Claude');
    expect(remoteControlName(on, { name: 'Claude by default' })).toBe('Claude by default');
  });

  it('11. an agent with no name is still asked for it, and its title is "Tars agent"', async () => {
    const { remoteControlName } = await import('../../../electron/providers/cli-provider');
    const name = remoteControlName({ remoteControlEnabled: true }, { provider: 'claude' });
    expect(name).toBe('');
    expect(remoteControlOf(await launch('claude', name))).toEqual({ present: true, name: 'Tars agent' });
  });

  it('12. the switch off or absent: never asked for', async () => {
    const { remoteControlName } = await import('../../../electron/providers/cli-provider');
    expect(remoteControlName({ remoteControlEnabled: false }, { name: 'A', provider: 'claude' })).toBeUndefined();
    expect(remoteControlName({}, { name: 'A', provider: 'claude' })).toBeUndefined();
    expect(remoteControlName(undefined, { name: 'A' })).toBeUndefined();
  });

  describe('the project in the title', () => {
    const on = { remoteControlEnabled: true };
    const project = (name: string) => path.join(os.tmpdir(), 'work', name);

    it('13. the project\'s folder name, then the agent\'s', async () => {
      const { remoteControlName } = await import('../../../electron/providers/cli-provider');
      expect(remoteControlName(on, { name: 'Revue finale', projectPath: project('Allcazz') })).toBe('Allcazz · Revue finale');
    });

    it('14. a name that already says its project is not said twice', async () => {
      const { remoteControlName } = await import('../../../electron/providers/cli-provider');
      expect(remoteControlName(on, { name: 'Agent on Allcazz', projectPath: project('Allcazz') })).toBe('Agent on Allcazz');
      expect(remoteControlName(on, { name: 'agent on allcazz', projectPath: project('Allcazz') })).toBe('agent on allcazz');
    });

    it('15. no name: the project\'s alone', async () => {
      const { remoteControlName } = await import('../../../electron/providers/cli-provider');
      expect(remoteControlName(on, { projectPath: project('Allcazz') })).toBe('Allcazz');
    });

    it('16. a trailing separator still names the folder', async () => {
      const { remoteControlName } = await import('../../../electron/providers/cli-provider');
      expect(remoteControlName(on, { name: 'Copywriting', projectPath: project('KarvanDesign') + path.sep })).toBe('KarvanDesign · Copywriting');
    });
  });

  it('17. a name or a project that is not text never stops the agent from starting', async () => {
    const { remoteControlName } = await import('../../../electron/providers/cli-provider');
    const on = { remoteControlEnabled: true };
    const odd = { name: 42 as unknown as string, projectPath: { x: 1 } as unknown as string, provider: 'claude' };
    expect(() => remoteControlName(on, odd)).not.toThrow();
    expect(remoteControlName(on, odd)).toBe('');
    expect(remoteControlName(on, { name: 'Copywriting', projectPath: 7 as unknown as string })).toBe('Copywriting');
  });

  it('18. a double quote or a backslash keeps the name one argument, with no option after it', async () => {
    const name = 'a" --dangerously-skip-permissions "b\\';
    const argv = await launch('claude', name);
    expect(remoteControlOf(argv)).toEqual({ present: true, name });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(promptOf(argv)).toEqual([TASK]);
  });

  for (const id of OTHER_APIS) {
    it(`8. ${id} runs claude against another API: never --remote-control`, async () => {
      const argv = await launch(id, 'Build the landing', { model: 'some-model' });
      expect(remoteControlOf(argv).present).toBe(false);
    });
  }
});
