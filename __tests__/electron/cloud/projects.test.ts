import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProject, gitUrlProblem, projectNameProblem, projectsRoot, type GitRunner } from '../../../electron/services/cloud/projects';
import { gitSshCommand } from '../../../electron/services/cloud/git-access';

/**
 * A project made on a Tars server, empty or cloned (services/cloud/projects.ts,
 * docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 2).
 *
 * How it fails, written before the code:
 * 1. a name that leaves the projects folder or names something else: `..`,
 *    `.`, `x/..`, `a/b`, `a\b`, `.git`, a leading `-` or `.`, a Windows
 *    device name (`NUL`, `con.txt`), a trailing dot or space, whitespace
 *    around it, a control character, over 100 characters, empty
 * 2. a name already there is replaced or merged into, instead of refused
 * 3. the projects folder is a link, or a file, and is used anyway; or it is
 *    missing and not made (0700)
 * 4. a git address outside the three shapes reaches git: `file:`, `ext::`,
 *    `http://`, `git://`, a local or relative path, one starting with `-`,
 *    `git@-oProxyCommand=x:y/z`, `git@host:../x`, a `%`, whitespace or a
 *    control character, over 2048 characters; or one carrying a credential:
 *    `https://user:pw@host/x`, `https://token@host/x`, `ssh://deploy@host/x`,
 *    `ssh://git:pw@host/x`; or the three good shapes refused
 * 5. git is called with the address where an option could be read (before
 *    `--`), or with submodules or full history
 * 6. a clone that fails, takes longer than its time, or grows past the size
 *    cap leaves its folder behind; or says nothing a person can act on
 * 7. an empty project is anything but a folder with `git init` run in it
 * 8. (Task 2b) a clone over SSH runs without the server's own key and the
 *    pinned hosts, or before they exist; or says nothing a person can act on
 *    when the host is unknown or the key not allowed; or runs at all when
 *    the key cannot be made
 */

let root: string;
let calls: Array<{ cwd: string; args: string[] }>;
beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-projects-')), 'projects');
  calls = [];
});

/** A git that records its calls; a clone writes the folder git would. */
const fakeGit = (behave: 'ok' | 'fail' | 'hang' | 'grow' = 'ok'): GitRunner => async (cwd, args, opts) => {
  calls.push({ cwd, args });
  if (args[0] === 'init') return { stdout: '', stderr: '' };
  const dir = path.join(cwd, args[args.length - 1]);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (behave === 'fail') throw Object.assign(new Error('exit 128'), { stderr: 'Cloning into x...\nfatal: repository not found\n' });
  if (behave === 'hang') throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', stderr: '' });
  if (behave === 'grow') {
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(4096));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 2000);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  }
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
  return { stdout: '', stderr: '' };
};

describe('projectNameProblem', () => {
  it('1. refuses every name that could leave the folder or name something else', () => {
    for (const name of ['', '.', '..', 'x/..', 'a/b', 'a\\b', '.git', '-x', '.hidden', 'NUL', 'con.txt', 'name.', 'name ', ' name', 'a\tb', 'a\nb', 'x'.repeat(101), 'café']) {
      expect(projectNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
  });
  it('1. takes a plain name', () => {
    for (const name of ['test-cloud', 'My project', 'tars_2.0', 'a']) expect(projectNameProblem(name), name).toBeNull();
  });
});

describe('gitUrlProblem', () => {
  it('4. refuses every address outside the three shapes', () => {
    for (const url of [
      'file:///etc', 'ext::sh -c touch% /tmp/x', 'http://github.com/a/b', 'git://github.com/a/b', '/srv/repo', '../repo', 'repo',
      '--upload-pack=touch /tmp/x', '-c core.x=y', '--upload-pack=x', '-oProxyCommand=x', 'git@-oProxyCommand=x:y/z', 'git@host:../x', 'git@host:a/../b', 'https://host/a/%2e%2e',
      'https://host/a b', 'https://host/a/b\n', 'https://host/' + 'a'.repeat(2048), 'https://host/a', 'ssh://git@host:2222/a/b', 'https://host:8443/a/b',
    ]) {
      expect(gitUrlProblem(url), url).not.toBeNull();
    }
  });
  it('4. refuses an address that carries a credential, and says so', () => {
    for (const url of ['https://user:pw@github.com/a/b', 'https://token@github.com/a/b', 'ssh://deploy@github.com/a/b', 'ssh://git:pw@github.com/a/b', 'deploy@github.com:a/b']) {
      expect(gitUrlProblem(url), url).toMatch(/name or password/);
    }
  });
  it('4. takes the three shapes', () => {
    for (const url of ['https://github.com/Nexarion434/Tars.git', 'https://gitlab.com/group/sub/repo', 'git@github.com:Nexarion434/Tars.git', 'ssh://git@github.com/Nexarion434/Tars', 'ssh://git@github.com:22/a/b']) {
      expect(gitUrlProblem(url), url).toBeNull();
    }
  });
});

describe('createProject', () => {
  it('7, 3. an empty project: the root made 0700, a folder, git init in it', async () => {
    const answer = await createProject('test-cloud', { kind: 'empty' }, { root, git: fakeGit() });
    expect(answer).toEqual({ ok: true, path: path.join(root, 'test-cloud') });
    expect(fs.statSync(path.join(root, 'test-cloud')).isDirectory()).toBe(true);
    expect(calls).toEqual([{ cwd: path.join(root, 'test-cloud'), args: ['init', '--quiet'] }]);
    if (process.platform !== 'win32') expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it('5. a clone: the address after --, no submodules, one commit deep, run in the root', async () => {
    const answer = await createProject('tars', { kind: 'git', url: 'https://github.com/Nexarion434/Tars.git' }, { root, git: fakeGit() });
    expect(answer).toEqual({ ok: true, path: path.join(root, 'tars') });
    expect(calls).toEqual([{ cwd: root, args: ['clone', '--no-recurse-submodules', '--depth', '1', '--', 'https://github.com/Nexarion434/Tars.git', 'tars'] }]);
  });

  // 8. Over SSH: the server's own key and the pinned hosts (git-access.ts, Task 2b).
  const access = () => ({ dir: path.join(path.dirname(root), 'git'), keygen: async (args: string[]) => {
    const file = args[args.indexOf('-f') + 1];
    fs.writeFileSync(file, 'PRIVATE', { mode: 0o600 });
    fs.writeFileSync(`${file}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl tars-server\n');
  } });

  it('8. a clone over ssh runs with the server\'s own key and the pinned hosts, made first', async () => {
    const gitAccess = access();
    const answer = await createProject('tars', { kind: 'git', url: 'git@github.com:Nexarion434/Tars.git' }, { root, git: fakeGit(), gitAccess });
    expect(answer).toEqual({ ok: true, path: path.join(root, 'tars') });
    expect(calls).toEqual([{ cwd: root, args: ['-c', `core.sshCommand=${gitSshCommand(gitAccess)}`, 'clone', '--no-recurse-submodules', '--depth', '1', '--', 'git@github.com:Nexarion434/Tars.git', 'tars'] }]);
    expect(fs.existsSync(path.join(gitAccess.dir, 'id_ed25519.pub'))).toBe(true);
    expect(fs.readFileSync(path.join(gitAccess.dir, 'known_hosts'), 'utf8')).toContain('github.com ssh-ed25519 ');
  });

  it('8. a host the server does not know, or a key it may not use, is said so, and leaves no folder', async () => {
    const unknown: GitRunner = async (cwd, args) => {
      calls.push({ cwd, args });
      throw Object.assign(new Error('exit 128'), { stderr: 'No ED25519 host key is known for git.example and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.\n' });
    };
    const answer = await createProject('x', { kind: 'git', url: 'ssh://git@git.example/a/b' }, { root, git: unknown, gitAccess: access() });
    expect(answer).toMatchObject({ ok: false, status: 502, error: expect.stringMatching(/does not know git\.example's key/) });
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
  });

  it('8. no key, no clone', async () => {
    const answer = await createProject('x', { kind: 'git', url: 'git@github.com:a/b' }, { root, git: fakeGit(), gitAccess: { dir: path.join(path.dirname(root), 'git'), keygen: async () => { throw new Error('no ssh-keygen'); } } });
    expect(answer).toMatchObject({ ok: false, status: 500, error: expect.stringMatching(/ssh-keygen/) });
    expect(calls).toEqual([]);
  });

  it('1, 4. a bad name or address: 400, and git never runs', async () => {
    expect(await createProject('..', { kind: 'empty' }, { root, git: fakeGit() })).toMatchObject({ ok: false, status: 400 });
    expect(await createProject('x', { kind: 'git', url: 'ext::sh -c x' }, { root, git: fakeGit() })).toMatchObject({ ok: false, status: 400 });
    expect(calls).toEqual([]);
  });

  it('2. a name already there: 409, the folder left as it was', async () => {
    fs.mkdirSync(path.join(root, 'taken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'taken', 'mine.txt'), 'keep');
    expect(await createProject('taken', { kind: 'empty' }, { root, git: fakeGit() })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already/) });
    expect(fs.readFileSync(path.join(root, 'taken', 'mine.txt'), 'utf8')).toBe('keep');
    expect(calls).toEqual([]);
  });

  it('3. a projects folder that is a file or a link is left alone', async () => {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, 'not a folder');
    expect(await createProject('x', { kind: 'empty' }, { root, git: fakeGit() })).toMatchObject({ ok: false, status: 500 });
    fs.rmSync(root);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-elsewhere-'));
    let linked = true;
    try { fs.symlinkSync(elsewhere, root, 'junction'); } catch { linked = false; }
    if (linked) {
      expect(await createProject('x', { kind: 'empty' }, { root, git: fakeGit() })).toMatchObject({ ok: false, status: 500 });
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('6. a clone that fails, or takes too long, leaves no folder and says why', async () => {
    const failed = await createProject('gone', { kind: 'git', url: 'https://github.com/a/b' }, { root, git: fakeGit('fail') });
    expect(failed).toMatchObject({ ok: false, status: 502, error: expect.stringMatching(/repository not found/) });
    expect(fs.existsSync(path.join(root, 'gone'))).toBe(false);
    const slow = await createProject('slow', { kind: 'git', url: 'https://github.com/a/b' }, { root, git: fakeGit('hang'), timeoutMs: 1000 });
    expect(slow).toMatchObject({ ok: false, status: 504, error: expect.stringMatching(/longer than/) });
    expect(fs.existsSync(path.join(root, 'slow'))).toBe(false);
  });

  it('6. a clone that grows past the size cap is stopped and its folder removed', async () => {
    const big = await createProject('big', { kind: 'git', url: 'https://github.com/a/b' }, { root, git: fakeGit('grow'), maxBytes: 1024, pollMs: 20 });
    expect(big).toMatchObject({ ok: false, status: 507, error: expect.stringMatching(/larger than/) });
    expect(fs.existsSync(path.join(root, 'big'))).toBe(false);
  });

  it('the projects folder is ~/projects', () => {
    expect(projectsRoot('/home/tars')).toBe(path.join('/home/tars', 'projects'));
  });
});
