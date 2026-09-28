import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Every call still reaches the real function: the spies only let a case look at
// a temp file the moment it is opened, before a byte is written to it.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, openSync: vi.fn(real.openSync) };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync), execFile: vi.fn(real.execFile) };
});

let tokenFile = '';
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  // Read by api-server at each call, after the case has picked its folder.
  return { ...actual, get API_TOKEN_FILE() { return tokenFile; } };
});

/**
 * Where a secret is born, on Windows (the review of win/secret-acl). Access is
 * checked when a handle is opened, Node opens with full sharing, and a handle
 * keeps what it was granted: `/inheritance:r` and `/reset` revoke nothing on a
 * handle already open. So a list set after the file exists is too late for
 * anyone who opened it in between, and keeps reading through that handle.
 *
 * How it can fail, written before the code:
 *  1. The temp of a secret save is made beside the target, under
 *     ~\.dorothy's list (which grants CodexSandboxUsers on this machine), and
 *     only closed afterwards: a process of those accounts watching the folder
 *     opens it in that window and keeps the handle.
 *  2. The temp is made in the staging directory before that directory is
 *     closed, so it is born with the home's list all the same.
 *  3. When the staging directory cannot be made or closed, the write is lost,
 *     or falls back without saying so.
 *  4. api-token is written in place: a handle opened on it before its list was
 *     set (an older build, a reader of the sandbox accounts) reads every token
 *     written after, since the file object stays the same.
 *  5. At startup, an api-token that already exists is closed in place: the same
 *     object, so a handle held from before keeps it, and `/reset` hands it the
 *     folder's list for a moment on the way.
 *
 * Real NTFS files, the real icacls; win32 only (darwin and linux: see
 * secret-file-acl.test.ts, case 7).
 */

const onWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ICACLS = path.join(systemRoot, 'System32', 'icacls.exe');
const realExec = (childProcess.execFileSync as unknown as { getMockImplementation(): typeof childProcess.execFileSync }).getMockImplementation()!;
const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;

type Dacl = { protectedFromParent: boolean; aces: string[] };
function dacls(...paths: string[]): Dacl[] {
  const out = String(realExec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '$env:TARS_ACL_PROBE -split [char]10 | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }'], {
    env: { ...process.env, TARS_ACL_PROBE: paths.join('\n') }, encoding: 'utf8', windowsHide: true,
  })).trim().split(/\r?\n/);
  return out.map((sddl) => {
    const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
    if (!d) throw new Error(`no DACL in ${sddl}`);
    return { protectedFromParent: d[1].includes('P'), aces: (d[2].match(/\([^)]*\)/g) ?? []).sort() };
  });
}

const made: string[] = [];
/** A folder that, like ~\.dorothy here, hands a group of other accounts read. */
function openHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-staging-'));
  made.push(dir);
  realExec(ICACLS, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], { stdio: 'ignore', windowsHide: true });
  return dir;
}

afterEach(() => {
  vi.mocked(fs.openSync).mockImplementation(realOpen);
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) {
    try { realExec(ICACLS, [dir, '/reset', '/T', '/Q'], { stdio: 'ignore', windowsHide: true }); } catch { /* removed below or not at all */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let userSid = '';
const ownerOnly = () => ({ protectedFromParent: true, aces: [`(A;;FA;;;${userSid})`, '(A;;FA;;;SY)'].sort() });
const inheritedOwnerOnly = () => [`(A;ID;FA;;;${userSid})`, '(A;ID;FA;;;SY)'].sort();

describe.runIf(onWindows)('a secret is born closed', { timeout: 180_000 }, () => {
  beforeAll(() => {
    userSid = String(realExec(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true })).trim();
  }, 180_000);

  it('1, 2: the temp is created in the closed staging directory, already closed, before a byte is written', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    await sf.closeSecretsToOtherAccounts([file], privateDir);

    const born: Array<{ at: string; size: number; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), size: fs.fstatSync(fd).size, list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);

    sf.writeSecretFileSync(file, '{"telegramBotToken":"x"}');

    expect(born).toHaveLength(1);
    expect(path.dirname(born[0].at).toLowerCase()).toBe(path.join(privateDir, '.staging').toLowerCase());
    expect(born[0].size, 'looked at before any content').toBe(0);
    expect(born[0].list.aces).toEqual(inheritedOwnerOnly());
    expect(dacls(file)[0]).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('{"telegramBotToken":"x"}');
    expect(fs.existsSync(`${file}.tmp`), 'nothing made beside the target').toBe(false);
  });

  it('2: a save made while the startup pass is still running is born closed too', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');

    const born: Array<{ at: string; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);

    // Not awaited: the pass has named the file and nothing is closed yet.
    const pass = sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"slackBotToken":"x"}');
    await pass;

    // The save's temp, then the pass's own copy of the file the save left.
    expect(born.map(b => path.basename(b.at).replace(/-[0-9a-f]{12}/, ''))).toEqual(['app-settings.json.tmp', 'app-settings.json.pass.tmp']);
    for (const b of born) {
      expect(path.dirname(b.at).toLowerCase()).toBe(path.join(privateDir, '.staging').toLowerCase());
      expect(b.list.aces, b.at).toEqual(inheritedOwnerOnly());
    }
    expect(dacls(file)[0]).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('{"slackBotToken":"x"}');
  });

  it('3: a staging directory that cannot be made falls back to the old order, says so, and keeps the write', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    fs.mkdirSync(privateDir);
    fs.writeFileSync(path.join(privateDir, '.staging'), 'a file where the directory should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"a":1}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(dacls(file)[0]).toEqual(ownerOnly());
    const said = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(said).toContain(file);
    expect(said).toMatch(/staging/);
  });

  it('4: a handle held on api-token never reads the token written after it', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    tokenFile = path.join(home, 'api-token');
    fs.writeFileSync(tokenFile, 'too-short-to-keep');
    await sf.closeSecretsToOtherAccounts([tokenFile], path.join(home, '.tars-private'));
    const held = fs.openSync(tokenFile, 'r');
    try {
      const api = await import('../../../electron/services/api-server');
      let minted = '';
      try {
        minted = api.getApiToken();
      } catch (err) {
        // The rename is refused while the handle is held: the new token went nowhere.
        expect((err as NodeJS.ErrnoException).code).toBe('EPERM');
      }
      const buf = Buffer.alloc(128);
      const n = fs.readSync(held, buf, 0, buf.length, 0);
      expect(buf.subarray(0, n).toString()).toBe('too-short-to-keep');
      if (minted) expect(fs.readFileSync(tokenFile, 'utf8')).toBe(minted);
    } finally {
      fs.closeSync(held);
    }
  });

  it('5: at startup an existing api-token becomes a new file object, same token, closed', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'api-token');
    fs.writeFileSync(file, 'b'.repeat(64));
    const before = fs.statSync(file, { bigint: true }).ino;

    await sf.closeSecretsToOtherAccounts([file], path.join(home, '.tars-private'));

    expect(fs.statSync(file, { bigint: true }).ino).not.toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('b'.repeat(64));
    expect(dacls(file)[0]).toEqual(ownerOnly());
  });
});
