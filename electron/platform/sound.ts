import * as path from 'path';
import { realFs, type Env, type FsProbe } from './fs-probe';
import { envValue } from './path-env';

/**
 * How Windows plays a notification sound (audit B N-06), as a program and its
 * arguments, never a command line built from the file.
 *
 * The file's path comes from app-settings.json, which sits in ~/.dorothy, the
 * directory every agent is handed. It used to be pasted into PowerShell code
 * (`(New-Object Media.SoundPlayer '<path>').PlaySync()`), so a `'` in a file
 * name ended the string and the rest ran. Here the script is one fixed text,
 * passed base64-encoded (-EncodedCommand, so no quoting rule applies to it
 * either), and the path reaches it as data, in the TARS_SOUND_FILE variable.
 *
 * Refused before anything starts: a path that is not a local absolute
 * `X:\...` one (a UNC path would be opened, and opening it sends the
 * account's NTLM hash to that host; `\\?\`, relative and drive-relative paths
 * have no business here), a control character, anything but `.wav` (the only
 * format SoundPlayer plays), and a file that is not there. PowerShell is
 * System32's, by its full path, with no profile: never a `powershell` found on
 * the PATH or in the working directory.
 */
// Progress off: PowerShell otherwise reports loading its modules as a CLIXML record on stderr.
const SCRIPT = "$ProgressPreference = 'SilentlyContinue'; (New-Object System.Media.SoundPlayer $env:TARS_SOUND_FILE).PlaySync()";

export type SoundCommand =
  | { ok: true; file: string; args: string[]; env: NodeJS.ProcessEnv }
  | { ok: false; error: string };

export function windowsSoundCommand(filePath: string, opts: { env?: Env; fs?: FsProbe } = {}): SoundCommand {
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? realFs;
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'no sound file' };
  if (/[\x00-\x1f\x7f]/.test(filePath)) return { ok: false, error: 'the sound file path holds a control character' };
  if (!/^[A-Za-z]:[\\/]/.test(filePath)) return { ok: false, error: 'the sound file must be a local absolute path (X:\\...)' };
  if (path.win32.extname(filePath).toLowerCase() !== '.wav') return { ok: false, error: 'only .wav files can be played' };
  if (!fs.isFile(filePath)) return { ok: false, error: 'the sound file is not there' };

  const systemRoot = envValue(env, 'SystemRoot', 'win32') || 'C:\\Windows';
  return {
    ok: true,
    file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    // Through unknown: Env and Next's ProcessEnv (which requires NODE_ENV) do not overlap.
    env: { ...env, TARS_SOUND_FILE: filePath } as unknown as NodeJS.ProcessEnv,
  };
}
