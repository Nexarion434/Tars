/**
 * The platform layer: every decision that differs between darwin/linux and
 * win32 in how Tars starts and ends processes, and how it names, compares,
 * guards and replaces files. Callers import from here and
 * pass no `if (win32)` of their own. darwin and linux get what they got
 * before this layer existed, byte for byte.
 */
export { realFs, type FsProbe, type Env } from './fs-probe';
export { envValue, getPath, withPath, pathEntries, joinPathEntries } from './path-env';
export { resolveShell, shellArgs } from './shell';
export { resolveCliBinary, findOnPath, type CliBinary, type CliBinaryFailure, type CliBinaryFailureReason } from './cli-binary';
export { posixWords, PosixWordsError, type PosixWordsErrorCode } from './posix-words';
export {
  buildWindowsCommandLine, quoteWindowsArg, quoteWindowsProgram, WindowsCommandLineError, WINDOWS_COMMAND_LINE_MAX,
  type WindowsCommandLineErrorCode,
} from './windows-command-line';
export { toLaunch, LaunchError, type Launch, type PosixLaunch, type DirectLaunch, type LaunchErrorCode } from './launch';
export { killTree, KillTreeError, type KillTreeResult, type KillTreeDeps, type KillTreeErrorCode } from './kill-tree';
export { samePath, isUnder, isInsideWorktreesDir } from './path-compare';
export { isUnsafePathSegment } from './windows-names';
export { encodeClaudeProjectDir, claudeProjectDirNames, decodeWindowsClaudeProjectDir, type DecodeDeps } from './claude-project-dir';
export { renameReplacingSync, RENAME_RETRY_BUDGET_MS, type RenameDeps } from './rename-replacing';
