# Windows port: rules every win-* agent follows

Read this before any work. It completes `CLAUDE.md` (upstream rules, still binding) and
`CLAUDE.local.md` (the mission). If they disagree, `CLAUDE.local.md` wins for git and scope,
`CLAUDE.md` wins for code style, security and testing.

## Machine

- Windows 11, x64, native (no WSL). Repo root: `C:\Users\nicol\Documents\Claude Project\Tars\tars`.
- **Node 22**: `nvm use` needs admin, so prefix the PATH in every shell you open:
  - PowerShell: `$env:Path = "C:\Users\nicol\AppData\Roaming\nvm\v22.23.3;" + $env:Path`
  - Git Bash: `export PATH="/c/Users/nicol/AppData/Roaming/nvm/v22.23.3:$PATH"`
  - Check `node -v` prints `v22.23.3` before running anything.
- **`bash` on the PATH is the WSL launcher** (`C:\WINDOWS\system32\bash.exe`). Never call bare
  `bash`. Git Bash is `C:\Program Files\Git\bin\bash.exe`.
- Absent: VS Build Tools C++, `jq`, `pwsh` 7. Present: Windows PowerShell 5.1, `wt.exe`, Python 3.10, Git for Windows, `gh`.
- Never install software, change system settings, or touch the real `%USERPROFILE%\.dorothy`,
  `%USERPROFILE%\.claude` or `%APPDATA%\tars`. Tests and manual runs use a sandbox home.
- **Safe test shell (mandatory until win-qa's harness lot is merged into `windows`).** On Windows
  `os.homedir()` reads `USERPROFILE`, not `HOME`, and Electron's own `getPath('home')` ignores the
  environment. Before `npm test`, `vitest`, `npm run e2e` or starting the app, in that shell:
  ```powershell
  $sb = Join-Path $env:TEMP ("tars-sb-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force "$sb\AppData\Roaming","$sb\AppData\Local" | Out-Null
  $env:HOME=$sb; $env:USERPROFILE=$sb; $env:APPDATA="$sb\AppData\Roaming"; $env:LOCALAPPDATA="$sb\AppData\Local"
  $env:TEMP="C:\Users\Public\tars-tmp"; $env:TMP=$env:TEMP; New-Item -ItemType Directory -Force $env:TEMP | Out-Null
  ```
  (`TEMP`/`TMP` outside the real profile only until `win/test-harness` is merged: the old guard
  refuses `%TEMP%` because it lives under `C:\Users\nicol`. Delete `C:\Users\Public\tars-tmp` after.)
  Tests that spawn `gh` must hit the fake, never `gh.exe` (release/prune-releases tests).
- **Never start `electron.exe` without `--user-data-dir=<sandbox>`** and the safe env: a bare run
  creates `%APPDATA%\Electron` (or `%APPDATA%\tars`) in the real profile. Canaries that must stay
  absent: `C:\Users\nicol\.dorothy`, `%APPDATA%\tars`, `%APPDATA%\Electron`, `%APPDATA%\Dorothy`.
- **Grep from Git Bash**: `export MSYS_NO_PATHCONV=1` first, or use the Grep tool (MSYS rewrites
  `/tmp`-like patterns and a search returns a false zero).
- **Encoding**: Windows PowerShell 5.1 `Get-Content`/`Set-Content` default to ANSI and mangle
  UTF-8 accents. Edit files with the Edit/Write tools or Node, never a PowerShell read-modify-write.
- **Symlinks**: Developer Mode is off on this machine (Nicolas's decision D4). A test that needs
  `fs.symlinkSync` detects the missing privilege on win32 and skips with a stated reason; it must
  still run on macOS, Linux and CI `windows-latest`.

## Git

- `main` mirrors `upstream/main`: never commit there. `windows` is the integration branch.
- One lot = one branch `win/<topic>` from `windows`, in your own worktree:
  `git worktree add .claude/worktrees/<agent>-<topic> -b win/<topic> windows`.
  Work only inside that worktree. Never edit a file inside another agent's worktree.
- **node_modules in a worktree**: run a real `npm ci` in the worktree (about 50 s; VS Build Tools
  are installed). Do NOT junction the main checkout's `node_modules`: Turbopack (`next dev`) refuses
  a junction that points outside the worktree. `npm ci` does not fetch the Electron binary: run
  `npx install-electron` (or copy `node_modules\electron\dist` from the main checkout). If an older
  worktree still holds a junction, remove it with `cmd /c rmdir node_modules` before anything else
  (never `Remove-Item -Recurse` or `git worktree remove --force` on a junction: they can follow it
  and wipe the main install).
- Stay inside the file scope your agent file declares. Need a change outside it: say so in
  your report, do not make it.
- Commit subjects: lowercase, `feat:` / `fix:` / `chore:` / `test:` / `perf:` / `security:`.
  No em dash or en dash anywhere you write (code, comments, docs, commits).
- Never push, never open a PR, never touch `JeanBrasse/Tars`. The orchestrator merges.

## Code (so the port stays mergeable with upstream)

1. **Smallest conflict surface.** Prefer new files and injectable functions over edits to
   upstream files. When an upstream file must change, change the fewest lines, ideally one call
   into the platform layer.
2. **One platform layer, no scattered `if (win32)`.** Platform decisions live in
   `electron/platform/` (and the existing `electron/utils/default-shell.ts`, `open-terminal.ts`,
   `path-builder.ts`, `cli-path-dirs.ts`). Everything else calls functions.
3. **darwin and linux behaviour is unchanged to the byte.** Existing tests stay green on all
   three platforms. When you touch a darwin/linux branch, prove it is identical.
4. **Upstream rules hold**: `execFile`/`spawn` with an argv array, never an interpolated shell
   string (Windows `.cmd` included: quote through one audited helper); paths from user input go
   through `electron/utils/worktree-path.ts`; `electron/preload.ts` and `src/types/electron.d.ts`
   change in the same commit; no temporary fix, no swallowed error.
5. **No visual change without Nicolas.** Title bar, tray, any pixel: propose, screenshot, stop.

## Tests (CLAUDE.md Workflow Rule 3)

- E2E first. A unit tested in isolation starts with a header listing every way it can fail,
  then the tests, then the code. No test written after the code it tests.
- Every test you add is shown to bite: run it against the old code or a mutant, see it red.
  A mutant of a script that acts on its working directory (build-renderer, release, sandbox...)
  runs only in a throwaway copy of the tree, never in your worktree or the main checkout.
- Before reporting done, from your worktree:
  `npx tsc --noEmit`, `npx tsc -p electron/tsconfig.json`, `npm test`, `npm run lint`,
  plus whatever the lot touches (`npm run e2e` for anything under `electron/` or `src/`).

## Report (your final message, short)

```
CHANGED   files + one line each
PROOF     each command, its exit code and the counts (tests passed/failed, errors)
RISKS     mac/linux regression risk, upstream conflict risk
QUESTIONS decisions only Nicolas or the orchestrator can make
```
