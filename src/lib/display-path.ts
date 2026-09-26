/**
 * A path as the renderer shows it: a project's name, the home as `~`, the
 * last folders of a path, a file under a project (audit B U-01, U-02, U-04,
 * U-05, U-07).
 *
 * Every site used to split on `/` and match the home as `/Users/<name>` or
 * `/home/<name>`. A Windows path has neither, so the app named each project
 * by its whole `C:\Users\...` path and never shortened one to `~`.
 *
 * The path says which system wrote it: a drive (`C:`, `C:\x`, `C:/x`) or a
 * leading backslash (`\\server\share`) is a Windows path, where `\` and `/`
 * are both separators. Anything else is read exactly as before, with `/` as
 * the only separator and `\` an ordinary character, so a macOS or Linux path
 * gives what the old expression gave at its site on every platform. The one
 * exception is a trailing `/`: the name is the folder's, as the main
 * process's projectName (electron/platform/project-name.ts) has it.
 *
 * Whether a path is absolute depends on the system that will use it, not on
 * its shape (a macOS app cannot use `C:\vault`), so isAbsolutePath is told
 * the platform.
 */

const DRIVE = /^[A-Za-z]:/;
const POSIX_HOME = /^\/(?:Users|home)\/[^/]+/;
const WINDOWS_HOME = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i;
const UNC_ROOT = /^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/;

/** A path Windows wrote: it starts with a drive or a backslash. */
export function isWindowsPath(p: string): boolean {
  return DRIVE.test(p) || p.startsWith('\\');
}

/** The platform the app runs on, as the preload reports it, or '' outside Electron. */
export function rendererPlatform(): string {
  return typeof window === 'undefined' ? '' : window.electronAPI?.platform ?? '';
}

/** The path's parts, and the separator to join them back with. */
export function splitPath(p: string): { parts: string[]; sep: '/' | '\\' } {
  if (!isWindowsPath(p)) return { parts: p.split('/'), sep: '/' };
  return { parts: p.split(/[\\/]/), sep: p.includes('\\') ? '\\' : '/' };
}

/** A Windows path's root: a share (`\\server\share\`), a drive (`C:\`), or a leading separator. */
function windowsRoot(p: string): string {
  return UNC_ROOT.exec(p)?.[0] ?? /^[A-Za-z]:[\\/]*/.exec(p)?.[0] ?? /^[\\/]*/.exec(p)![0];
}

/**
 * The last folder or file of a path, trailing separators dropped, or '' for
 * a root or an empty path, which each caller replaces with its own fallback.
 */
export function pathName(p: string): string {
  if (!isWindowsPath(p)) return p.replace(/\/+$/, '').split('/').pop() ?? '';
  return p.slice(windowsRoot(p).length).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/** The last `n` parts of a path, joined with its own separator. */
export function pathTail(p: string, n: number): string {
  const { parts, sep } = splitPath(p);
  return parts.slice(-n).join(sep);
}

/** A `/`-separated path relative to `base`, under it, with base's separator. */
export function joinPath(base: string, relative: string): string {
  const { sep } = splitPath(base);
  return sep === '/' ? `${base}/${relative}` : `${base}\\${relative.split('/').join('\\')}`;
}

/** A Windows path with `/` for its separators, to compare it the way a posix one is; any other path as it is. */
export function toSlashes(p: string): string {
  return isWindowsPath(p) ? p.replace(/\\/g, '/') : p;
}

/**
 * The home folder shown as `~`: `/Users/<name>` or `/home/<name>`, and on
 * Windows a drive's `Users\<name>`, keeping the separator written after it.
 * The home itself stays as it is unless `bareHome` (the chat head's `~`).
 */
export function tildePath(p: string, { bareHome = false }: { bareHome?: boolean } = {}): string {
  const home = (isWindowsPath(p) ? WINDOWS_HOME : POSIX_HOME).exec(p)?.[0];
  if (!home) return p;
  const rest = p.slice(home.length);
  if (!rest) return bareHome ? '~' : p;
  return `~${rest}`;
}

/** An absolute path on `platform`: a leading `/`, and on Windows also a drive or a leading `\`. */
export function isAbsolutePath(p: string, platform: string): boolean {
  if (platform !== 'win32') return p.startsWith('/');
  return /^(?:[A-Za-z]:)?[\\/]/.test(p);
}
