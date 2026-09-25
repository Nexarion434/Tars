# Prior art: Nicolas's earlier Dorothy Windows port (1.2.8)

Read-only research of 2026-09-25, before the installed build was uninstalled at Nicolas's request.
The installed Dorothy 1.2.8 came from Nicolas's own private fork `Nexarion434/Dorothy` (now deleted),
never from `Charlie85270/Dorothy`, whose public releases are all mac-only. Tars forked Dorothy at
1.2.9 (merge-base `470b8ac7`), so none of this reached Tars. The source checkout may still exist at
`C:\Users\nicol\Documents\Claude Project\Dorothy Windows Version\` (read-only reference).
No Windows CI existed in that lineage: treat everything below as unvetted.

## What it did

| Area | Dorothy 1.2.8 on Windows | Tars port decision |
|---|---|---|
| Platform layer | one `electron/services/cli-detector.ts` behind `IS_WIN` (quoteArg, cdAndRun, getAgentShell, getLoginShellArgs, getPtyPlatformOptions, findCli via the `which` package, buildFullPath) | same idea: `electron/platform/` |
| Agent spawn | absolute `powershell.exe`, no login args, `useConpty: true`, then the quoted command typed into the PTY | **rejected** (D2): typing into PowerShell runs prompt lines as commands (audit A4, proved). Tars spawns the CLI directly |
| Hooks | `.cmd` one-liners calling `powershell -File <hook>.ps1`, shared `_hooks-common.ps1` (stdin JSON, POST 3 s, swallow errors); Gemini hooks left as `.sh` (broken) | **Node runner** (D1): one runtime on all 3 OS, upstreamable |
| Hook registration | native path with `\` replaced by `/` in `~/.claude/settings.json` | same (forward slashes, quoted) |
| Kill | node-pty `kill()` only, no tree kill | Tars adds `killTree` (taskkill /T /F) for ACP trees |
| ConPTY | `useConpty: true`; a reverted experiment: `conptyInheritCursor: true` broke TUI redraw (black terminal) | do not enable `conptyInheritCursor` |
| Packaging | per-user NSIS under `%LOCALAPPDATA%\Programs\<app>` (no elevation), `icon.ico`, `asarUnpack` of node-pty (win32 prebuilds) and better-sqlite3, `publish` repointed to the fork (`app-update.yml`) | reuse (phase 5) |
| Auto-update | `electron-updater` (`autoDownload=false`, `autoInstallOnAppQuit=true`) + GitHub API fallback; win32 asset matcher: `*setup*<arch>*.exe`, then `*setup*.exe`, then `*-portable.exe`, then any `.exe` | reuse the matcher in `update-checker.ts` fallback (phase 5) |
| Signing | none | open question (SmartScreen) |
| Window | `titleBarStyle: 'hiddenInset'` unconditional (no-op on Windows: native frame + menu bar), a `before-input-event` hack forcing Ctrl+C/V/X/A | **do not copy**: needs a real win32 title bar (Nicolas decides) |
| Tray | same PNGs on every OS | `.ico` + panel position (Nicolas decides) |
| Lifecycle | `window-all-closed` quits, `before-quit` kills all PTYs | open decision for Nicolas (close = hide to tray?) |
