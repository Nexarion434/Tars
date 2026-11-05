import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runServerCommand, problemSentence, type SshProblem } from '../../../electron/services/cloud-link/remote-run';
import { sshCommandArgv, type ServerRunner } from '../../../electron/services/cloud-link/ssh';

/**
 * One server command over SSH (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 2).
 * The server's CLI writes one JSON line on stdout when it succeeds and says
 * what went wrong on stderr; `ssh` exits 255 for its own errors.
 *
 * How it fails:
 * - `ssh` missing on this computer (the spawn errors, nothing ever exits)
 * - the host key unknown, or changed: `BatchMode` refuses both, and the user
 *   has to run `ssh <host>` once in a terminal to look at the key
 * - the key refused, no route, no DNS, a refused or timed out connection
 * - the command hung past the timeout: killed, not left behind
 * - `sudo -n` wanting a password; the CLI, `node` or the container missing
 *   (exit 127, `No such container`, `Cannot find module`); the container stopped
 * - the SSH user's shell printing a banner before the JSON (Review Focus 1)
 * - an answer whose last line is not a JSON object; a JSON line over 64 KB;
 *   stdout that never ends
 * - stdin JSON put on the command line, where the remote shell would read it;
 *   stdin left open when there is no input, so the remote CLI waits forever
 * - a profile that fails Task 1's checks reaching `ssh` at all
 */

const FAKE_SSH = { file: process.execPath, args: [path.join(__dirname, '..', '..', 'fixtures', 'fake-ssh.cjs')] };
const HOST = 'ubuntu@203.0.113.10';
const PROFILE = { host: HOST, runner: { kind: 'docker', container: 'tars-server', sudo: true } as ServerRunner };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remote-run-'));
}

function fake(vars: Record<string, string>) {
  return { ssh: FAKE_SSH, env: { ...process.env, ...vars } };
}

describe('runServerCommand', () => {
  it('reads the last json line past a login banner', async () => {
    const stdout = 'Welcome to Ubuntu 24.04 LTS\r\n\r\n * Documentation: https://help.ubuntu.com\r\nLast login: Mon Nov 2 21:42\r\n{"running":true,"serverId":"d795d0ff4d5d8e50"}\r\n\r\n';
    const result = await runServerCommand(PROFILE, { do: 'status' }, fake({ FAKE_SSH_STDOUT: stdout }));
    expect(result).toEqual({ ok: true, json: { running: true, serverId: 'd795d0ff4d5d8e50' } });
  });

  it("runs the profile's own command, no more", async () => {
    const argvFile = path.join(tmp(), 'argv.json');
    await runServerCommand(PROFILE, { do: 'clients-revoke', id: 'c_10eafeea' }, fake({ FAKE_SSH_ARGV_FILE: argvFile, FAKE_SSH_STDOUT: '{"revoked":true}\n' }));
    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual(sshCommandArgv(HOST, PROFILE.runner, { do: 'clients-revoke', id: 'c_10eafeea' }));
  });

  it('an answer whose last line is not a json object is unreadable, its first 200 characters shown', async () => {
    const long = `Goodbye ${'y'.repeat(300)}`;
    for (const stdout of [`{"running":true}\n${long}\n`, '[1,2]\n', 'null\n', '"text"\n', '', '\n\n', '{"running":tr\n']) {
      const result = await runServerCommand(PROFILE, { do: 'status' }, fake({ FAKE_SSH_STDOUT: stdout }));
      expect(result.ok, JSON.stringify(stdout)).toBe(false);
      if (result.ok) continue;
      expect(result.problem).toBe<SshProblem>('unreadable');
      expect(result.detail.length).toBeLessThanOrEqual(200);
    }
    const shown = await runServerCommand(PROFILE, { do: 'status' }, fake({ FAKE_SSH_STDOUT: `${long}\n` }));
    expect(shown).toEqual({ ok: false, problem: 'unreadable', detail: long.slice(0, 200) });
  });

  it('a json line over 64 KB is unreadable', async () => {
    const result = await runServerCommand(PROFILE, { do: 'clients-list' }, fake({ FAKE_SSH_BIG_LINE: String(70 * 1024) }));
    expect(result).toMatchObject({ ok: false, problem: 'unreadable' });
    const endless = await runServerCommand(PROFILE, { do: 'clients-list' }, fake({ FAKE_SSH_BIG_LINE: String(2 * 1024 * 1024), FAKE_SSH_HANG: '1' }));
    expect(endless).toMatchObject({ ok: false, problem: 'unreadable' });
  });

  it("classifies ssh's own errors in plain words", async () => {
    const cases: Array<[string, number, SshProblem]> = [
      ['No ED25519 host key is known for 203.0.113.10 and you have requested strict checking.\r\nHost key verification failed.\r\n', 255, 'host-key-unknown'],
      ['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nHost key verification failed.\r\n', 255, 'host-key-changed'],
      ['ubuntu@203.0.113.10: Permission denied (publickey).\r\n', 255, 'key-refused'],
      ['ssh: Could not resolve hostname tars-vps: Name or service not known\r\n', 255, 'unreachable'],
      ['ssh: connect to host 203.0.113.10 port 22: Connection timed out\r\n', 255, 'unreachable'],
      ['ssh: connect to host 10.0.0.1 port 22: No route to host\r\n', 255, 'unreachable'],
      ['ssh: connect to host 203.0.113.10 port 22: Connection refused\r\n', 255, 'unreachable'],
      ['ssh: connect to host 203.0.113.10 port 22: Network is unreachable\r\n', 255, 'unreachable'],
      ['sudo: a password is required\n', 1, 'sudo-password'],
      ['Error response from daemon: No such container: tars-server\n', 1, 'not-installed'],
      ['bash: line 1: node: command not found\n', 127, 'not-installed'],
      ["Error: Cannot find module '/home/tars/tars/electron/dist/server/cli.js'\n", 1, 'not-installed'],
      ['Error response from daemon: container 3f2a9c is not running\n', 1, 'container-stopped'],
      ['the server could not take its lock\n', 1, 'failed'],
    ];
    for (const [stderr, exit, problem] of cases) {
      const result = await runServerCommand(PROFILE, { do: 'status' }, fake({ FAKE_SSH_STDERR: stderr, FAKE_SSH_EXIT: String(exit) }));
      expect(result, stderr).toMatchObject({ ok: false, problem });
      if (!result.ok) expect(result.detail.length).toBeLessThanOrEqual(200);
    }
    const failed = await runServerCommand(PROFILE, { do: 'status' }, fake({ FAKE_SSH_STDERR: 'the server could not take its lock\n', FAKE_SSH_EXIT: '1' }));
    expect(failed).toEqual({ ok: false, problem: 'failed', detail: 'the server could not take its lock' });
  });

  it('ssh missing on this computer', async () => {
    const result = await runServerCommand(PROFILE, { do: 'status' }, { ssh: { file: path.join(tmp(), 'no-ssh-here'), args: [] } });
    expect(result).toMatchObject({ ok: false, problem: 'ssh-missing' });
  });

  it('kills a command past its timeout', async () => {
    const pidFile = path.join(tmp(), 'pid');
    const started = Date.now();
    const result = await runServerCommand(PROFILE, { do: 'status' }, { ...fake({ FAKE_SSH_HANG: '1', FAKE_SSH_PID_FILE: pidFile }), timeoutMs: 400 });
    expect(result).toMatchObject({ ok: false, problem: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('clients add input goes on stdin', async () => {
    const dir = tmp();
    const input = { name: 'PC-Nicolas (desktop)', kind: 'machine', scopes: ['see', 'drive'] };
    const result = await runServerCommand(PROFILE, { do: 'clients-add' }, {
      ...fake({ FAKE_SSH_STDIN_FILE: path.join(dir, 'stdin'), FAKE_SSH_ARGV_FILE: path.join(dir, 'argv.json'), FAKE_SSH_STDOUT: '{"id":"c_10eafeea","credential":"k","serverId":"d795d0ff4d5d8e50"}\n' }),
      stdin: input,
    });
    expect(result).toEqual({ ok: true, json: { id: 'c_10eafeea', credential: 'k', serverId: 'd795d0ff4d5d8e50' } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8'))).toEqual(input);
    expect(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')).not.toMatch(/PC-Nicolas|drive/);
  });

  it('closes stdin when there is no input, so the remote command never waits on it', async () => {
    const dir = tmp();
    const result = await runServerCommand(PROFILE, { do: 'status' }, { ...fake({ FAKE_SSH_STDIN_FILE: path.join(dir, 'stdin'), FAKE_SSH_STDOUT: '{"running":false}\n' }), timeoutMs: 5000 });
    expect(result).toEqual({ ok: true, json: { running: false } });
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('');
  });

  it('a profile failing its checks never reaches ssh', async () => {
    const argvFile = path.join(tmp(), 'argv.json');
    for (const profile of [
      { host: '-oProxyCommand=calc', runner: PROFILE.runner },
      { host: HOST, runner: { kind: 'command', argv: ['node;rm'] } as ServerRunner },
    ]) {
      const result = await runServerCommand(profile, { do: 'status' }, fake({ FAKE_SSH_ARGV_FILE: argvFile }));
      expect(result).toMatchObject({ ok: false, problem: 'refused' });
    }
    expect(fs.existsSync(argvFile)).toBe(false);
  });
});

describe('problemSentence', () => {
  it('says what to do, in plain words, for every problem', () => {
    const problems: SshProblem[] = ['ssh-missing', 'host-key-unknown', 'host-key-changed', 'key-refused', 'unreachable', 'timeout', 'sudo-password', 'not-installed', 'container-stopped', 'unreadable', 'refused', 'failed'];
    const sentences = problems.map(problem => problemSentence(problem, HOST));
    expect(new Set(sentences).size).toBe(problems.length);
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const sentence of sentences) expect(sentence).not.toMatch(dashes);
    expect(problemSentence('host-key-unknown', HOST)).toContain(`ssh ${HOST}`);
    expect(problemSentence('host-key-changed', HOST)).toContain(`ssh ${HOST}`);
  });
});
