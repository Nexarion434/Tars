import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readLink, saveProfile, forgetProfile, publicView, profileProblem, newProfileId, type ServerProfile,
} from '../../../electron/services/cloud-link/store';

/**
 * The desktop's servers, in PRIVATE_DIR/cloud-link.json (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 3).
 *
 * How it fails:
 * - a missing file, or one that does not parse, or one of another shape: read
 *   as no server, and left as it is until the user saves
 * - an entry that fails the checks (a host or runner Task 1 refuses, an id or
 *   credential of the wrong form) read as a server, and handed to `ssh`
 * - a profile that fails the checks saved: a Docker runner without the door's
 *   socket path on the host, a client id without its credential
 * - the file written readable by other accounts, or its folder listable
 * - the credential, or the door's socket path, reaching the window through
 *   publicView, under any key, at any depth
 * - Forget leaving the profile, or removing another one
 */

const posix = process.platform !== 'win32';
const CREDENTIAL = 'Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-Zx9_Zx9-abc';

function file(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cloud-link-')), 'private', 'cloud-link.json');
}

function profile(over: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 's_1a2b3c4d',
    host: 'ubuntu@203.0.113.10',
    runner: { kind: 'docker', container: 'tars-server', sudo: true },
    doorSocket: '/home/ubuntu/tars-cloud/home/.tars-private/door.sock',
    ...over,
  };
}

const PAIRED = profile({ serverId: 'd795d0ff4d5d8e50', name: 'srv1539916', clientId: 'c_10eafeea', credential: CREDENTIAL });

describe('readLink', () => {
  it('a missing file is no server', () => {
    expect(readLink(file())).toEqual({ servers: [] });
  });

  it('a corrupt file is no server, and is left as it is', () => {
    for (const raw of ['{"version":1,"servers":[', 'null', '{"version":2,"servers":[]}', '{"version":1,"servers":{}}', '[]']) {
      const f = file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, raw);
      const read = readLink(f);
      expect(read.servers, raw).toEqual([]);
      expect(read.problem, raw).toMatch(/cloud-link\.json/);
      expect(fs.readFileSync(f, 'utf8')).toBe(raw);
    }
  });

  it('drops an entry that fails the checks', () => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const bad = [
      profile({ id: 's_2', host: '-oProxyCommand=calc' }),
      profile({ id: 's_3a3a3a3a', runner: { kind: 'command', argv: ['node;rm'] } }),
      profile({ id: 's_4a4a4a4a', credential: 'short' }),
      { id: 's_5a5a5a5a' },
    ];
    fs.writeFileSync(f, JSON.stringify({ version: 1, servers: [PAIRED, ...bad] }));
    const read = readLink(f);
    expect(read.servers).toEqual([PAIRED]);
    expect(read.problem).toBeDefined();
  });
});

describe('saveProfile', () => {
  it('saves, reads back and replaces by id', () => {
    const f = file();
    saveProfile(f, profile());
    saveProfile(f, PAIRED);
    saveProfile(f, profile({ id: 's_99999999', host: 'tars-vps', runner: { kind: 'command', argv: ['node', '/srv/tars/electron/dist/server/cli.js'] }, doorSocket: undefined }));
    const read = readLink(f);
    expect(read.servers.map(s => s.id)).toEqual(['s_1a2b3c4d', 's_99999999']);
    expect(read.servers[0]).toEqual(PAIRED);
  });

  it('refuses a profile that fails the checks, and writes nothing', () => {
    const f = file();
    for (const bad of [
      profile({ id: 'one' }),
      profile({ host: 'a b' }),
      profile({ runner: { kind: 'docker', container: '-x', sudo: true } }),
      profile({ runner: { kind: 'docker', container: 'tars-server', sudo: 'yes' as unknown as boolean } }),
      profile({ doorSocket: undefined }),
      profile({ doorSocket: 'door.sock' }),
      profile({ clientId: 'c_10eafeea' }),
      profile({ credential: CREDENTIAL }),
      profile({ clientId: 'c_1', credential: CREDENTIAL }),
      profile({ serverId: 'D795' }),
      profile({ name: 'x'.repeat(200) }),
    ]) {
      expect(profileProblem(bad), JSON.stringify(bad)).not.toBeNull();
      expect(() => saveProfile(f, bad), JSON.stringify(bad)).toThrow();
    }
    expect(fs.existsSync(f)).toBe(false);
  });

  it("a save over a corrupt file writes the user's server", () => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"version":1,');
    saveProfile(f, PAIRED);
    expect(readLink(f)).toEqual({ servers: [PAIRED] });
  });

  it.runIf(posix)('writes the file 0600 in a 0700 folder', () => {
    const f = file();
    saveProfile(f, PAIRED);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
  });

  it('new ids pass the checks and differ', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProfileId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(profileProblem(profile({ id }))).toBeNull();
  });
});

describe('forgetProfile', () => {
  it('removes that profile only', () => {
    const f = file();
    saveProfile(f, PAIRED);
    saveProfile(f, profile({ id: 's_99999999' }));
    expect(forgetProfile(f, 's_1a2b3c4d')).toBe(true);
    expect(readLink(f).servers.map(s => s.id)).toEqual(['s_99999999']);
    expect(forgetProfile(f, 's_1a2b3c4d')).toBe(false);
  });
});

describe('publicView', () => {
  function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      visit(key, inner);
      walk(inner, visit);
    }
  }

  it('never carries the credential or the door socket, under any key', () => {
    const view = publicView(PAIRED);
    walk(view, (key, value) => {
      expect(key).not.toMatch(/credential|doorSocket/i);
      expect(value).not.toBe(CREDENTIAL);
      expect(value).not.toBe(PAIRED.doorSocket);
    });
    expect(JSON.stringify(view)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(view)).not.toContain('door.sock');
    expect(view).toMatchObject({ id: 's_1a2b3c4d', host: 'ubuntu@203.0.113.10', serverId: 'd795d0ff4d5d8e50', name: 'srv1539916', clientId: 'c_10eafeea', paired: true });
    expect(publicView(profile()).paired).toBe(false);
  });
});
