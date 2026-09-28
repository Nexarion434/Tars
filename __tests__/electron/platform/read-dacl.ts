import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** The access-list reader the ACL tests shared by copy, moved here as it was. */

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export type Dacl = { protectedFromParent: boolean; aces: string[] };

export function readDacls(...paths: string[]): Dacl[] {
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '$env:TARS_ACL_PROBE -split [char]10 | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }'], {
    env: { ...process.env, TARS_ACL_PROBE: paths.join('\n') }, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  return out.map((sddl) => {
    const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
    if (!d) throw new Error(`no DACL in ${sddl}`);
    return { protectedFromParent: d[1].includes('P'), aces: (d[2].match(/\([^)]*\)/g) ?? []).sort() };
  });
}

export function currentUserSid(): string {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
}
