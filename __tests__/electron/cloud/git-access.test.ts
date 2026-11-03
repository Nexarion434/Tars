import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GITHUB_HOST_KEYS, addKnownHost, ensureKnownHosts, gitKey, gitSshCommand, gitSshProblem, keyFingerprint, knownHostProblem, type Keygen,
} from '../../../electron/services/cloud/git-access';

/**
 * The server's own Git access (services/cloud/git-access.ts,
 * docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 2b): an SSH key
 * made on the server, never a desktop's, and the git hosts' keys pinned.
 *
 * How it fails, written before the code:
 * 1. the pinned lines are not exactly GitHub's published keys (their
 *    fingerprints, from `gh api meta`, 2026-11-03: ED25519
 *    +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU, ECDSA
 *    p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM, RSA
 *    uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s), or a fingerprint is
 *    computed another way than ssh-keygen's SHA256
 * 2. the key: made more than once, or over an existing one; made through a
 *    link at its path; a private key without its public half replaced; a
 *    private key others can read used (POSIX); the private key in an answer
 * 3. known_hosts: the pinned lines missing, the operator's lines lost, a
 *    link at its path written through
 * 4. a line the operator adds that ssh would read wider than one host and
 *    one key: a wildcard, a negation, a list, a hashed host, a
 *    @cert-authority or @revoked marker, an unknown type, a type the key
 *    does not carry, bad base64, more fields, a leading dash
 * 5. ssh run by git with anything that accepts a host it does not know:
 *    StrictHostKeyChecking other than yes, the user's config or the system's
 *    known hosts read, host keys updated, agent forwarding, a path unquoted
 * 6. git's failures not said in words a person can act on: an unknown host
 *    key, the server's key not allowed
 */

const [ED25519, ECDSA, RSA] = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'].map(t => GITHUB_HOST_KEYS.find(l => l.split(' ')[1] === t)!);
const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nNOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----\n';
const PUBLIC_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

let dir: string;
let keygens: string[][];
const keygen: Keygen = async (args) => {
  keygens.push(args);
  const file = args[args.indexOf('-f') + 1];
  fs.writeFileSync(file, PRIVATE, { mode: 0o600 });
  fs.writeFileSync(`${file}.pub`, `ssh-ed25519 ${PUBLIC_BLOB} tars-server\n`);
};
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-git-access-')), 'git');
  keygens = [];
});

describe('pinned host keys', () => {
  it('1. are GitHub\'s published keys, by their fingerprints', () => {
    expect(GITHUB_HOST_KEYS).toHaveLength(3);
    for (const line of GITHUB_HOST_KEYS) expect(line.startsWith('github.com ')).toBe(true);
    expect(keyFingerprint(ED25519)).toBe('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    expect(keyFingerprint(ECDSA)).toBe('SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM');
    expect(keyFingerprint(RSA)).toBe('SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s');
  });
});

describe('gitKey', () => {
  it('2. makes the key once, on the server, ed25519 with no passphrase, in a 0700 folder; answers the public half only', async () => {
    const first = await gitKey({ dir, keygen, serverId: 'd795d0ff4d5d8e50' });
    expect(first).toEqual({ ok: true, publicKey: `ssh-ed25519 ${PUBLIC_BLOB} tars-server`, fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' });
    expect(keygens).toEqual([['-q', '-t', 'ed25519', '-N', '', '-C', 'tars-server d795d0ff4d5d8e50', '-f', path.join(dir, 'id_ed25519')]]);
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    await gitKey({ dir, keygen, serverId: 'd795d0ff4d5d8e50' });
    expect(keygens).toHaveLength(1);
  });

  it('2. a private key without its public half is left, not replaced', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'id_ed25519'), PRIVATE, { mode: 0o600 });
    expect(await gitKey({ dir, keygen, serverId: 's' })).toMatchObject({ ok: false, error: expect.stringMatching(/public half/) });
    expect(fs.readFileSync(path.join(dir, 'id_ed25519'), 'utf8')).toBe(PRIVATE);
    expect(keygens).toEqual([]);
  });

  it('2. a link at the key\'s path is refused, and nothing is made through it', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-elsewhere-')), 'k');
    let linked = true;
    try { fs.symlinkSync(elsewhere, path.join(dir, 'id_ed25519')); } catch { linked = false; }
    if (!linked) return; // no symlink privilege on this Windows (Developer Mode off): CI's runners cover it
    expect(await gitKey({ dir, keygen, serverId: 's' })).toMatchObject({ ok: false });
    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(keygens).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('2. a private key others can read is refused', async () => {
    await gitKey({ dir, keygen, serverId: 's' });
    fs.chmodSync(path.join(dir, 'id_ed25519'), 0o644);
    expect(await gitKey({ dir, keygen, serverId: 's' })).toMatchObject({ ok: false, error: expect.stringMatching(/others can read/) });
  });
});

describe('known_hosts', () => {
  it('3. holds the pinned lines, keeps the operator\'s, and refuses a link', () => {
    expect(ensureKnownHosts({ dir })).toEqual({ ok: true });
    const file = path.join(dir, 'known_hosts');
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toEqual([...GITHUB_HOST_KEYS]);
    fs.appendFileSync(file, `gitlab.example ${ED25519.split(' ').slice(1).join(' ')}\n`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.includes('ecdsa')).join('\n'));
    ensureKnownHosts({ dir });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toContain(ECDSA);
    expect(lines.some(l => l.startsWith('gitlab.example '))).toBe(true);
  });

  it('4. refuses every line ssh would read wider than one host and one key', () => {
    const blob = ED25519.split(' ')[2];
    for (const line of [
      `*.example ssh-ed25519 ${blob}`, `!bad.example ssh-ed25519 ${blob}`, `a.example,b.example ssh-ed25519 ${blob}`, `|1|abc=|def= ssh-ed25519 ${blob}`,
      `@cert-authority host.example ssh-ed25519 ${blob}`, `@revoked host.example ssh-ed25519 ${blob}`, `host.example ssh-dss ${blob}`,
      `host.example ssh-rsa ${blob}`, `host.example ssh-ed25519 not*base64`, `host.example ssh-ed25519 ${blob} comment`, `-oX ssh-ed25519 ${blob}`, '',
    ]) {
      expect(knownHostProblem(line), line).not.toBeNull();
    }
    expect(knownHostProblem(`git.example ssh-ed25519 ${blob}`)).toBeNull();
    expect(knownHostProblem(`[git.example]:2222 ssh-ed25519 ${blob}`)).toBeNull();
  });

  it('4. a line added comes back with its fingerprint, to compare', () => {
    const blob = ED25519.split(' ')[2];
    expect(addKnownHost(`git.example ssh-ed25519 ${blob}`, { dir })).toEqual({ ok: true, fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' });
    expect(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8')).toContain(`git.example ssh-ed25519 ${blob}`);
    expect(addKnownHost(`*.example ssh-ed25519 ${blob}`, { dir })).toMatchObject({ ok: false });
  });
});

describe('gitSshCommand', () => {
  it('5. accepts no host it does not know, reads no other config, forwards nothing', () => {
    const command = gitSshCommand({ dir: '/home/tars/.tars-private/git' });
    expect(command).toBe(
      `ssh -F none -i '/home/tars/.tars-private/git/id_ed25519' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes `
      + `-o UserKnownHostsFile='/home/tars/.tars-private/git/known_hosts' -o GlobalKnownHostsFile=${os.devNull} -o UpdateHostKeys=no -o ForwardAgent=no`,
    );
    expect(gitSshCommand({ dir: "/home/o'neil/git" })).toContain(`-i '/home/o'\\''neil/git/id_ed25519'`);
  });

  it('6. says a git failure in words a person can act on', () => {
    expect(gitSshProblem('No ED25519 host key is known for git.example and you have requested strict checking.\nHost key verification failed.\n', 'git.example'))
      .toMatch(/does not know git\.example's key/);
    expect(gitSshProblem('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'github.com'))
      .toMatch(/not allowed on github\.com/);
    expect(gitSshProblem('fatal: repository not found', 'github.com')).toBeNull();
  });
});
