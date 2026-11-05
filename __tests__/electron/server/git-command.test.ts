import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGitCommand } from '../../../electron/server/git-command';

/**
 * tars-server git key | known-host add (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 5, the operator's part of Task 2b): the server's public key, to add to
 * GitHub, and a git host's key line, added by hand.
 *
 * How it fails, written before the code:
 * 1. `key` answers anything but the public key and its fingerprint (the
 *    private half, a path), or makes the key twice
 * 2. `known-host add` takes its line from the command line (a remote shell
 *    would read it) instead of stdin, adds a line wider than one host and
 *    one key, or says no fingerprint to compare
 * 3. an unknown verb exits 0
 */

const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const setup = () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-git-cmd-')), 'git');
  let made = 0;
  const keygen = async (args: string[]) => {
    made += 1;
    const file = args[args.indexOf('-f') + 1];
    fs.writeFileSync(file, 'PRIVATE KEY', { mode: 0o600 });
    fs.writeFileSync(`${file}.pub`, `ssh-ed25519 ${ED25519} tars-server\n`);
  };
  const lines: string[] = [];
  return { deps: { dir, keygen, serverId: 'd795d0ff4d5d8e50' }, lines, out: (l: string) => lines.push(l), made: () => made };
};

describe('tars-server git', () => {
  it('1. key: the public key and its fingerprint, the key made once', async () => {
    const t = setup();
    expect(await runGitCommand(['key', '--json'], '', t.deps, t.out)).toBe(0);
    expect(await runGitCommand(['key', '--json'], '', t.deps, t.out)).toBe(0);
    expect(t.made()).toBe(1);
    expect(t.lines.map(l => JSON.parse(l))).toEqual([
      { publicKey: `ssh-ed25519 ${ED25519} tars-server`, fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' },
      { publicKey: `ssh-ed25519 ${ED25519} tars-server`, fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' },
    ]);
    expect(t.lines.join('\n')).not.toContain('PRIVATE');
  });

  it('2. known-host add: the line from stdin, one host and one key, its fingerprint said back', async () => {
    const t = setup();
    expect(await runGitCommand(['known-host', 'add', '--json'], `git.example ssh-ed25519 ${ED25519}\n`, t.deps, t.out)).toBe(0);
    expect(JSON.parse(t.lines[0])).toEqual({ host: 'git.example', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' });
    expect(fs.readFileSync(path.join(t.deps.dir, 'known_hosts'), 'utf8')).toContain(`git.example ssh-ed25519 ${ED25519}`);
    expect(await runGitCommand(['known-host', 'add'], `*.example ssh-ed25519 ${ED25519}\n`, t.deps, t.out)).toBe(1);
    expect(await runGitCommand(['known-host', 'add', `git.example ssh-ed25519 ${ED25519}`], '', t.deps, t.out)).toBe(1);
    expect(t.lines).toHaveLength(1);
  });

  it('3. an unknown verb is usage, exit 2', async () => {
    const t = setup();
    expect(await runGitCommand(['clone'], '', t.deps, t.out)).toBe(2);
    expect(await runGitCommand([], '', t.deps, t.out)).toBe(2);
  });
});
