import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Read access lists, for the ACL tests (owner-only, secret-file-acl,
 * secret-file-staging), as SDDL: SIDs, whatever the language of the machine.
 *
 * Windows PowerShell 5.1, by its System32 path, and .NET only: no module is
 * loaded. On CI the step's shell is PowerShell 7, whose PSModulePath the 5.1
 * child inherited; it found PowerShell 7's Microsoft.PowerShell.Security
 * first, could not load it, and had no Get-Acl (run 36419462139). So the child
 * gets no PSModulePath (5.1 then builds its own), and the script calls
 * File/Directory.GetAccessControl, which needs no module at all.
 *
 * Loud: a read that fails, or returns fewer lists than it was asked for,
 * throws with the paths, the exit code, stderr and stdout. 5.1 exits 0 when a
 * command it cannot find fails, so the count is checked, not only the code.
 */

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export type Dacl = { protectedFromParent: boolean; aces: string[] };

/** The environment the child runs in: this one, less PSModulePath (whatever its case). */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v;
  return { ...env, ...extra };
}

function powershell(script: string, extra: Record<string, string> = {}): { lines: string[]; describe: () => string; ok: boolean } {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference = 'Stop'; ${script}`], { env: childEnv(extra), encoding: 'utf8', windowsHide: true });
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  return {
    lines: stdout.trim() ? stdout.trim().split(/\r?\n/) : [],
    ok: !r.error && r.status === 0,
    describe: () => `exit ${r.status ?? 'none'}${r.error ? ` (${r.error.message})` : ''}\nstderr: ${stderr.trim() || '(empty)'}\nstdout: ${stdout.trim() || '(empty)'}`,
  };
}

const READ = '$env:TARS_ACL_PROBE -split [char]10 | ForEach-Object { '
  + 'if ([System.IO.Directory]::Exists($_)) { [System.IO.Directory]::GetAccessControl($_, \'Access\').GetSecurityDescriptorSddlForm(\'Access\') } '
  + 'else { [System.IO.File]::GetAccessControl($_, \'Access\').GetSecurityDescriptorSddlForm(\'Access\') } }';

export function readDacls(...paths: string[]): Dacl[] {
  const run = powershell(READ, { TARS_ACL_PROBE: paths.join('\n') });
  if (!run.ok || run.lines.length !== paths.length) {
    throw new Error(`reading the access list of ${paths.join(', ')} failed: ${run.describe()}`);
  }
  return run.lines.map((sddl, i) => {
    const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
    if (!d) throw new Error(`no DACL for ${paths[i]} in ${JSON.stringify(sddl)}: ${run.describe()}`);
    return { protectedFromParent: d[1].includes('P'), aces: (d[2].match(/\([^)]*\)/g) ?? []).sort() };
  });
}

export function currentUserSid(): string {
  const run = powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  const sid = run.lines[0]?.trim() ?? '';
  if (!run.ok || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)) throw new Error(`reading the current user's SID failed: ${run.describe()}`);
  return sid;
}
