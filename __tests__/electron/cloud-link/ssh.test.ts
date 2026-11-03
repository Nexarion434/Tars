import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hostProblem, runnerProblem, remoteWords, sshCommandArgv, sshForwardArgv, spawnSsh,
  type ServerCommand, type ServerRunner,
} from '../../../electron/services/cloud-link/ssh';

/**
 * The desktop's `ssh` calls to a Tars server (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 1).
 * `ssh` hands its remote command to the remote user's shell as one string, so
 * every word the desktop puts there must read back as itself, and the host is
 * an argument `ssh` must never take for an option.
 *
 * How it fails:
 * - a host starting with `-` (read as an option: `-oProxyCommand=...` runs a
 *   command on the desktop), holding whitespace, a control character or a
 *   shell character, empty, an empty user or host, over 255 characters
 * - a runner word (program, path, container) with a shell character, a space,
 *   a leading `-` (an option of the remote program), `~`, `$` or a leading `=`
 *   (zsh expands `=cmd`): the remote shell would read something else
 * - a revoke id that is not the server's `c_<8 hex>`, so a word like `--all`
 *   or `c_1;x` reaches the remote command line
 * - a forward to a relative socket path, or one holding `:` (it splits `-L`'s
 *   spec) or whitespace; a local port outside 1024 to 65535; a local socket
 *   path longer than a Unix socket address holds
 * - `StrictHostKeyChecking` turned off, `BatchMode` missing (a hidden prompt
 *   hangs the connect), the host anywhere but right after `--`
 * - a word the remote shell would split or expand (checked by a real `sh` on POSIX)
 * - `ssh` started through a shell on the desktop, which would read the argv again
 */

const posix = process.platform !== 'win32';
const FAKE_SSH = path.join(__dirname, '..', '..', 'fixtures', 'fake-ssh.cjs');
const DOCKER: ServerRunner = { kind: 'docker', container: 'tars-server', sudo: true };
const BARE: ServerRunner = { kind: 'command', argv: ['node', '/home/tars/tars/electron/dist/server/cli.js'] };
const COMMANDS: ServerCommand[] = [
  { do: 'status' }, { do: 'start' }, { do: 'clients-add' }, { do: 'clients-list' }, { do: 'clients-revoke', id: 'c_10eafeea' },
];
const SOCKET = '/home/ubuntu/tars-cloud/home/.tars-private/door.sock';

describe('hostProblem', () => {
  it('accepts user@host, an address and an SSH alias', () => {
    for (const host of ['ubuntu@100.101.245.29', 'tars-vps', 'me@host.example.com', 'tars_user@srv1539916']) {
      expect(hostProblem(host), host).toBeNull();
    }
  });

  it('refuses hosts that are not [user@]host', () => {
    for (const host of [
      '', '-oProxyCommand=calc', 'u@-oProxyCommand=calc', 'a b', 'host\n', 'host\t', 'h;rm', '$(x)', '`x`', 'h|x',
      '@host', 'u@', 'a@b@c', 'x'.repeat(256), 'host\u0000', 'ssh://u@h:22',
    ]) {
      expect(hostProblem(host), JSON.stringify(host)).toMatch(/host/i);
    }
  });
});

describe('runnerProblem', () => {
  it('accepts a bare install and a docker container', () => {
    expect(runnerProblem(BARE)).toBeNull();
    expect(runnerProblem(DOCKER)).toBeNull();
    expect(runnerProblem({ kind: 'docker', container: 'tars.server_2', sudo: false })).toBeNull();
  });

  it('refuses runner words a remote shell would read', () => {
    for (const argv of [[], ['node;rm'], ['-e'], ['=ls'], ['a b'], ['$HOME/cli.js'], ['~/bin/tars-server'], ['node', 'x"y'], ['node', "x'y"], ['a\nb'], ['*']]) {
      expect(runnerProblem({ kind: 'command', argv }), JSON.stringify(argv)).not.toBeNull();
    }
    for (const container of ['', '-x', 'a;b', 'a b', '.hidden', 'x'.repeat(129)]) {
      expect(runnerProblem({ kind: 'docker', container, sudo: true }), JSON.stringify(container)).not.toBeNull();
    }
  });
});

describe('remoteWords', () => {
  it("docker runner execs the server's cli with sudo -n", () => {
    expect(remoteWords(DOCKER, { do: 'status' })).toEqual(
      ['sudo', '-n', 'docker', 'exec', '-i', 'tars-server', 'node', 'electron/dist/server/cli.js', 'status', '--json'],
    );
    expect(remoteWords({ ...DOCKER, sudo: false }, { do: 'clients-add' })).toEqual(
      ['docker', 'exec', '-i', 'tars-server', 'node', 'electron/dist/server/cli.js', 'clients', 'add', '--json'],
    );
    expect(remoteWords(BARE, { do: 'clients-list' })).toEqual([...BARE.argv, 'clients', 'list', '--json']);
  });

  it('start goes through the runner', () => {
    expect(remoteWords(DOCKER, { do: 'start' })).toEqual(['sudo', '-n', 'docker', 'start', 'tars-server']);
    expect(remoteWords(BARE, { do: 'start' })).toEqual([...BARE.argv, 'start', '--json']);
  });

  it("puts only the server's own client ids on a revoke", () => {
    expect(remoteWords(BARE, { do: 'clients-revoke', id: 'c_10eafeea' })).toEqual([...BARE.argv, 'clients', 'revoke', 'c_10eafeea']);
    for (const id of ['--all', 'c_10eafeea;x', 'c_XYZXYZXY', 'c_10eafee', 'c_10eafeea0', '']) {
      expect(() => remoteWords(BARE, { do: 'clients-revoke', id }), id).toThrow(/client/i);
    }
  });

  it('refuses a runner that fails its check', () => {
    expect(() => remoteWords({ kind: 'command', argv: ['tars;rm'] }, { do: 'status' })).toThrow();
  });

  it.runIf(posix)('the remote words parse back as themselves in sh', () => {
    for (const runner of [DOCKER, BARE]) {
      for (const command of COMMANDS) {
        const words = remoteWords(runner, command);
        const read = execFileSync('/bin/sh', ['-c', `for w in ${words.join(' ')}; do printf '%s\\n' "$w"; done`], { encoding: 'utf8' });
        expect(read.trimEnd().split('\n')).toEqual(words);
      }
    }
  });
});

describe('sshCommandArgv', () => {
  it('the host always follows --, the remote command last', () => {
    for (const command of COMMANDS) {
      const argv = sshCommandArgv('ubuntu@100.101.245.29', DOCKER, command);
      const end = argv.indexOf('--');
      expect(argv[end + 1]).toBe('ubuntu@100.101.245.29');
      expect(argv.slice(end + 2)).toEqual([remoteWords(DOCKER, command).join(' ')]);
      expect(argv.slice(0, end).every(a => a.startsWith('-') || /^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9]+$/.test(a))).toBe(true);
    }
  });

  it('never turns host key checking off, never prompts', () => {
    const all = [sshCommandArgv('tars-vps', BARE, { do: 'status' }), sshForwardArgv('tars-vps', { kind: 'tcp', port: 47117 }, SOCKET)];
    for (const argv of all) {
      expect(argv.join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/i);
      expect(argv).toContain('BatchMode=yes');
      expect(argv).toContain('ControlPath=none');
    }
  });

  it("never forwards the desktop's agent, display or local commands, whatever the user's config says", () => {
    const command = sshCommandArgv('tars-vps', BARE, { do: 'status' });
    const forward = sshForwardArgv('tars-vps', { kind: 'tcp', port: 47117 }, SOCKET);
    for (const argv of [command, forward]) {
      for (const option of ['ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no']) expect(argv, option).toContain(option);
      // Options before the host: ssh reads nothing after it as its own.
      expect(argv.indexOf('ForwardAgent=no')).toBeLessThan(argv.indexOf('--'));
    }
    // A command binds no forward of the config; the forward keeps its own -L, which this would clear.
    expect(command).toContain('ClearAllForwardings=yes');
    expect(forward).not.toContain('ClearAllForwardings=yes');
  });

  it('refuses a bad host before anything else', () => {
    expect(() => sshCommandArgv('-oProxyCommand=calc', BARE, { do: 'status' })).toThrow(/host/i);
  });
});

describe('sshForwardArgv', () => {
  it("forward options are T3's plus BatchMode", () => {
    const argv = sshForwardArgv('ubuntu@100.101.245.29', { kind: 'tcp', port: 47117 }, SOCKET);
    for (const option of ['ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'ControlMaster=no', 'ControlPath=none']) {
      expect(argv, option).toContain(option);
    }
    expect(argv).toEqual(expect.arrayContaining(['-n', '-N', '-T']));
    expect(argv[argv.indexOf('-L') + 1]).toBe(`127.0.0.1:47117:${SOCKET}`);
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['ubuntu@100.101.245.29']);
    const unix = sshForwardArgv('tars-vps', { kind: 'unix', path: '/Users/nicolas/.tars-private/cloud/s1.sock' }, SOCKET);
    expect(unix[unix.indexOf('-L') + 1]).toBe(`/Users/nicolas/.tars-private/cloud/s1.sock:${SOCKET}`);
  });

  it('refuses ends that would not forward where they say', () => {
    const tcp = { kind: 'tcp', port: 47117 } as const;
    for (const remote of ['door.sock', '/a:b/door.sock', '/a b/door.sock', '', '/x\n']) {
      expect(() => sshForwardArgv('tars-vps', tcp, remote), JSON.stringify(remote)).toThrow(/socket/i);
    }
    for (const port of [0, 80, 1023, 65536, 1.5, Number.NaN]) {
      expect(() => sshForwardArgv('tars-vps', { kind: 'tcp', port }, SOCKET), String(port)).toThrow(/port/i);
    }
    for (const local of ['relative.sock', 'C:/x.sock', '/a:b.sock', `/${'x'.repeat(110)}.sock`, '/x\n.sock']) {
      expect(() => sshForwardArgv('tars-vps', { kind: 'unix', path: local }, SOCKET), local).toThrow(/socket/i);
    }
    expect(() => sshForwardArgv('-oProxyCommand=calc', tcp, SOCKET)).toThrow(/host/i);
  });
});

describe('spawnSsh', () => {
  it('argv reaches ssh unchanged, no shell', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-ssh-')), 'argv.json');
    const argv = ['-o', 'BatchMode=yes', '--', 'tars-vps', 'a b;c $HOME "q" %PATH% `x`'];
    const child = spawnSsh(argv, { ssh: { file: process.execPath, args: [FAKE_SSH] }, env: { ...process.env, FAKE_SSH_ARGV_FILE: out } });
    const code = await new Promise(resolve => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(argv);
  });
});
