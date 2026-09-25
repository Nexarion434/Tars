# Audit B: Tars on Windows 11, everything outside audit A's scope

Repo: `C:\Users\nicol\Documents\Claude Project\Tars\tars`, branch `windows`, upstream 1.9.0 (`ca2bef37`).
Read-only. Scope: the rest of `electron/`, the seven `mcp-*`, `scripts/**`, `package.json`, CI,
`next.config.ts`, `e2e/**`, `__tests__/**`, OS-dependent parts of `src/**`.

## 0. Read this first (safety, before anyone runs a test)

1. **`npm test` and `npm run e2e` on Windows point the app at the REAL profile.** On Windows,
   `os.homedir()` reads `USERPROFILE` and ignores `HOME` (measured here: `HOME=/c/nowhere node -e
   "require('os').homedir()"` printed `C:\Users\nicol`; Node doc: https://nodejs.org/api/os.html#oshomedir).
   `DATA_DIR` = `os.homedir()/.dorothy` (`electron/constants/index.ts:29`).
   - vitest: `__tests__/setup/home-isolation.ts:121` sets `HOME` only. Its fs guard turns writes
     into `%USERPROFILE%` into failures for `node:fs`, but not for better-sqlite3 (native, `vault.db`)
     nor for child processes (hooks, CLIs) the tests spawn.
   - e2e: `e2e/fixture.mjs:561` sets `HOME` + `CFFIXED_USER_HOME` only. The app then reads and writes
     `C:\Users\nicol\.dorothy` and `.claude`. The fixture's "outside the sandbox" check (`:563-590`)
     asks Electron's `getPath()` only, never `os.homedir()`, so it will not catch it.
   Until win-qa redirects `USERPROFILE` (+ `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`/`HOMEPATH`) do not
   run either suite on this machine.
2. **Git Bash rewrites arguments that look like POSIX paths** (MSYS path conversion): `rg "/tmp"` from
   Git Bash searched for `C:/Users/.../Temp` and returned 0 on a known hit. Every agent grepping from
   Git Bash must `export MSYS_NO_PATHCONV=1` or use the Grep tool. All sweeps below were re-run that way
   and each pattern was proven on a known hit.
3. Many files below are in **no agent's exclusive scope** (`electron/handlers/ipc-handlers.ts`,
   `cli-paths-handlers.ts`, `gws-handlers.ts`, `hermes-handlers.ts`, `services/mcp-orchestrator.ts`,
   `services/bot-core.ts`, `services/kanban-*.ts`, `services/memory-service.ts`, `utils/index.ts`,
   `utils/resume-session.ts`, `utils/decode-project-path.ts`, `utils/worktree-path.ts`,
   `utils/kanban-generate.ts`, `mcp-telegram/src`, most of `src/`). The owner column is my proposal;
   the orchestrator has to grant the scope.

## 1. Findings

Priority: P0 app or agents do not start / real data at risk; P1 feature broken; P2 build, test, release,
copy. 82 findings: **P0 6, P1 32, P2 44**.

### Bootstrap and dev start

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| B-01 | `npm run electron:dev` | `package.json:15` | `NODE_ENV=development electron .` is POSIX env syntax; cmd.exe (npm's shell on Windows) fails. Note `isDevBuild()` uses `app.isPackaged`, NODE_ENV is only read in 4 places | P0 | win-build | `npm run electron:dev` from PowerShell opens the window; exit 0 of `electron:start` chain |
| B-02 | native modules / Electron binary | `package.json` (no `postinstall`, no `install-app-deps`), `scripts/release.mjs:131-148` | Electron 44 downloads no binary on install (`npx install-electron` is a separate step, per release.mjs). better-sqlite3 13 is not N-API: needs a build for Electron's ABI; VS Build Tools C++ absent on this machine (CONVENTIONS). node-pty 1.1 should ship win32 prebuilds (verify) | P0 | win-build | `npx electron -e "require('better-sqlite3')(':memory:');require('node-pty')"` with `ELECTRON_RUN_AS_NODE=1` exits 0 |

### Agents: create, start, terminals (call sites outside audit A's files)

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| A-01 | "+ Agent" (create) | `electron/handlers/ipc-handlers.ts:279`, `:393` | `shell = '/bin/bash'`, `args: ['-l']` handed to `spawnAgentPty`: ConPTY cannot start `/bin/bash`, `agent:create` throws, no agent is created from the UI | P0 | win-process (needs ipc-handlers scope) | E2E: create an agent in the sandbox, PTY pid > 0, card shows idle |
| A-02 | Start agent (UI, autostart, restart) | `ipc-handlers.ts:843-858` | Types `cd '<path>' && <cmd>` with POSIX `'\''` quoting into the terminal. Windows PowerShell 5.1 has no `&&`; cmd.exe has no single-quote quoting. Nothing launches (same pattern in audit A's `agent-routes.ts:246`) | P0 | win-providers (launch line in the CLIProvider contract) | E2E `surfaces.spec` `settleFleet` sees the CLI in every seeded terminal |
| A-03 | Switch agent to local provider | `ipc-handlers.ts:631-632` | Same hardcoded `/bin/bash -l` | P1 | win-process | unit on the spawn args + manual switch |
| A-04 | Telegram/Slack/Discord start an agent | `electron/services/bot-core.ts:233`, `:241-242` | Same typed `cd '...' && cmd` launch | P1 | win-providers | bot-core unit with a fake PTY records a Windows launch line; manual Telegram `/start_agent` |
| A-05 | Quick terminal, Projects "Terminal", pty:create | `ipc-handlers.ts:185`, `:2920` | `pty.spawn(defaultShell(), ['-l'])`: `-l` is not a Windows PowerShell 5.1 or cmd switch. Args must come from the platform layer with the shell | P1 | win-process | E2E: Projects page Terminal button shows a prompt |
| A-06 | Skill install (Extensions) | `ipc-handlers.ts:1346` | `pty.spawn('npx', ...)`: `npx` is `npx.cmd`; ConPTY's CreateProcess appends only `.exe`, so ENOENT | P1 | win-process | E2E or manual: install a skill, PTY exit code 0 |
| A-07 | Plugin install | `ipc-handlers.ts:1511-1537` | `shell -c "<cmd>"`; first allowed shape contains `&&` (not PS 5.1), `claude "/plugin ..."` quoting, cmd needs `/d /s /c` | P1 | win-process | unit on the argv per shell kind + manual install |
| A-08 | Settings > System, Claude version | `ipc-handlers.ts:1820` | `execSync('claude --version 2>/dev/null')` runs in cmd.exe, `/dev/null` does not exist: always "Unknown". Also a shell string | P2 | win-process | Settings > System shows the version |
| A-09 | Tasmania MCP status | `ipc-handlers.ts:2666` | `exec('claude mcp list')` shell string (works through cmd.exe, violates the argv rule) | P2 | win-process | argv helper, unit |
| A-10 | Version probes (`shell:version`) | `ipc-handlers.ts:2876-2890` | `execFile(binary, ['--version'])`: a `.cmd` shim fails with EINVAL since Node 18.20.2/20.12.2 (CVE-2024-27980, https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows, April 2024), bare `claude` never resolves `.cmd`; the regex refuses `(`/`)` so every path under `C:\Program Files (x86)` is "invalid binary" | P1 | win-platform (spawn helper) | unit: `.cmd`, `.exe`, path with parentheses; Settings > CLI paths shows versions |
| A-11 | Kanban "generate task" | `electron/utils/kanban-generate.ts:47-56` + `claude-provider.ts:148-160` | `exec()` of a POSIX single-quoted one-shot command through cmd.exe: `'claude'` is not a command, always falls back; user prompt and project names go through cmd | P1 | win-providers (buildOneShotCommand) + utils call site | unit: argv form, no shell; manual generate returns parsed JSON |

### CLI detection and PATH (Settings > CLI paths, Google Workspace)

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| C-01 | CLI auto-detect | `electron/handlers/cli-paths-handlers.ts:67`, `:428`, `:433`, `:570` | `PATH.split(':')` / `join(':')`: `C:\a;D:\b` splits at the drive colons; `~/.dorothy/cli-paths.json` `fullPath` written corrupt (read by MCP per OPERATIONS.md) | P1 | win-platform (`pathEntries()`, `path.delimiter`) | unit failures-first on a Windows PATH; `cli-paths.json` fullPath round-trips |
| C-02 | CLI auto-detect | `cli-paths-handlers.ts:57-63`, `:88-95` (and the 12 siblings to `:390`), `:300` | `existsSync(dir/'claude')` with no PATHEXT: misses `claude.exe`/`.cmd`, and in `%APPDATA%\npm` matches npm's extensionless **sh** shim, which Windows cannot run. Dirs are mac (`/opt/homebrew`, `Library/pnpm`, `~/.nvm`) | P1 | win-platform (`resolveCliBinary()`) | unit with a fake dir holding `claude`, `claude.cmd`, `claude.exe` |
| C-03 | CLI auto-detect | `cli-paths-handlers.ts:98-379` (13 calls) | `execAsync('which X')` through cmd.exe: `which` does not exist (Git's is in `usr\bin`, not on PATH); use `where.exe` via execFile | P1 | win-platform | same unit, detection returns `where.exe` answer |
| C-04 | CLI auto-detect | `cli-paths-handlers.ts:47` | `execFile(shell, ['-ilc','echo $PATH'])` fails silently on Windows, falls back to `process.env.PATH` (acceptable once C-01 is fixed) | P2 | win-platform | none needed beyond C-01 |
| C-05 | Google Workspace | `electron/handlers/gws-handlers.ts:80-113`, `:118-148`, `:181-183` | Same `/opt/homebrew`, `which`, `join(':')`; `execAsync(`"${gwsPath}" auth status --json`)` is an interpolated shell string; gcloud on Windows is `gcloud.cmd` under `%LOCALAPPDATA%\Google\Cloud SDK` | P1 | win-platform | unit + Settings > Google Workspace detects gws/gcloud |
| C-06 | Settings > CLI paths "Additional PATH" | `src/components/Settings/CLIPathsSection.tsx:49`, `:54`, `:87` | Parses and prints the list with `:`; `C:\tools` becomes `C` and `\tools` | P1 | win-shell-ui | E2E surface `settings-cli-paths` edit + reload keeps `C:\tools` |

### MCP servers (7 bundled)

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| M-01 | Orchestrator MCP setup / status | `electron/services/mcp-orchestrator.ts:335-344`, `:370`, `:402` | `execFile('claude', ...)`: works for the native installer's `claude.exe`, ENOENT for npm's `claude.cmd` | P1 | win-platform helper (+ mcp-orchestrator.ts scope) | unit with a `.cmd` shim; Settings shows orchestrator configured |
| M-02 | MCP builds | `mcp-*/package.json` `build` | `tsc && esbuild ... --banner:js="...'module'..."` through cmd.exe and `esbuild.cmd`'s `%*`: should survive, unverified | P2 | win-build | `npm run build` in each of the 7 dirs exit 0, `node dist/bundle.js` answers an MCP `initialize` |
| M-03 | Telegram send-file guard (security) | `mcp-telegram/src/index.ts:35-42`, `electron/services/api-routes/utils.ts:78-98` | Blocklist is POSIX dotfiles; Windows credential stores live in `%APPDATA%`/`%LOCALAPPDATA%` (gh `GitHub CLI\hosts.yml`, gcloud `credentials.db`, browser profiles, Tars's own Electron profile `%APPDATA%\tars`). Same gap exists for `~/Library` on mac | P1 | win-platform | unit: `%APPDATA%\GitHub CLI\hosts.yml` refused by both guards |

### Worktrees

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| W-01 | Worktree guard hardening (security) | `electron/utils/worktree-path.ts:21-46` | Sound against traversal (see Q2). Admits Windows device names (`CON`, `feat/nul`, `COM1`) and trailing-dot components (`a./b` is `a/b` for Win32, measured: resolves to `.worktrees\a.\b`) | P2 | win-platform | failures-first unit: device names and trailing dots refused on win32, darwin unchanged |
| W-02 | Projects list hides worktrees | `ipc-handlers.ts:2332`, `electron/services/claude-service.ts:270` | `/\/\.?worktrees\//` never matches `\` paths: worktrees listed as projects | P2 | win-platform | unit on a backslash path |
| W-03 | Agent in a worktree files a Kanban task | `electron/services/kanban-board.ts:320-324` | `want.startsWith(own + '/')` and case-sensitive equality: a worktree path `C:\p\.worktrees\x` gets 403 | P1 | win-platform (`isUnder()`/`samePath()`) | unit + MCP kanban create from a worktree agent |

### Review (git)

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| R-01 | Review page | `electron/services/git-review.ts` | argv only, LF parsing, `git.exe` on PATH: cross-platform. Only the renderer labels break (see U-02) | none | none | covered by U-02 |

### Usage

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| G-01 | Usage | `electron/services/transcript-usage.ts:447`, `usage-ledger.ts:16` | Walks `~/.claude/projects/**/*.jsonl` with `path.join`, no path decoding: cross-platform | none | none | E2E `usage` surface on Windows |

### Memory, Projects, sessions (Claude's `~/.claude/projects` encoding)

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| H-01 | Projects page, Brain, Memory list, fs:read-project-files roots | `electron/utils/decode-project-path.ts:16-60` (via `services/project-index.ts:40`, `ipc-handlers.ts:2343`, `:2443`, `claude-service.ts:262`, `memory-service.ts:99`) | Decoder starts at `/`, never emits `C:`, never rebuilds spaces. Measured: `C--Users-nicol-Documents-Claude-Project-Tars` decodes to `\C\Users\nicol\Documents\Claude\Project\Tars`. `fs:list-projects` drops every project Claude has seen | P1 | win-platform | failures-first unit with Windows names; E2E Projects page lists a seeded Claude project |
| H-02 | Resume on restart, panel history | `electron/utils/resume-session.ts:24-29`, `electron/services/agent-transcript.ts:327-340` | `replace(/[/.]/g,'-')` leaves `C:\Users\x\proj` untouched; measured transcript path `...\.claude\projects\C:\Users\x\proj\<id>.jsonl` never exists: every restart starts a new conversation, panel history says "not found" | P1 | win-platform | unit; E2E `panel-history` on Windows |
| H-03 | Memory: create MEMORY.md for a Tars project | `electron/services/memory-service.ts:85-87`, `:156` | Same `[/.]` encoder: `memoryDir` contains `C:` mid-path, `mkdirSync` fails | P1 | win-platform | unit; manual create from Memory page |
| H-04 | Memory file name guard | `memory-service.ts:203` | Refuses `/` and `..`, not `\` (subdirectory creation only, stays inside) | P2 | win-platform | unit |
| H-05 | E2E seed | `e2e/fixture.mjs:526` | Seeds transcripts with the `[/.]` encoding | P2 | win-qa | panel-history spec green on Windows |

### Hermes, Tasmania

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| I-01 | Import Hermes Desktop config | `electron/handlers/hermes-handlers.ts:43-45` | `~/Library/Application Support/Hermes/connection.json`: never found on Windows (Hermes Desktop's Windows location unknown) | P2 | win-platform | unit on the per-platform location |
| I-02 | Tailscale status | `hermes-handlers.ts:125` | Bare `tailscale` works only if on PATH; add `C:\Program Files\Tailscale\tailscale.exe` | P2 | win-platform | unit with injected candidates |
| I-03 | Tasmania token | `electron/services/tasmania-client.ts:6` | `~/Library/Application Support/Tasmania` (Tasmania looks mac-only) | P2 | win-platform | decide: hide Tasmania on win32 or locate |

### Bots

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| J-01 | Bot messages name the project | `bot-core.ts:95`, `telegram-bot.ts:464`, `discord-bot.ts:189`, `utils/index.ts:247`, `:261` | `projectPath.split('/').pop()` prints the whole Windows path | P2 | win-shell-ui | unit on formatter |
| (A-04) | Bots start agents | see A-04 | | | | |

Network side of Telegram/Slack/Discord: cross-platform.

### Tray

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| K-01 | Tray panel position | `electron/core/tray-panel-manager.ts:75-88` | Placed at `trayBounds.y + height + 4` (below the icon), only X clamped: taskbar at the bottom puts the panel off screen | P1 | win-shell-ui (visual) | screenshot of the panel above the taskbar |
| K-02 | Tray toggle | `tray-panel-manager.ts:52-54`, `tray-manager.ts:67-71` | On Windows the panel's `blur` fires before the tray `click`: click to close reopens it | P2 | win-shell-ui | manual |
| K-03 | Tray icon | `tray-manager.ts:13-18`, `:55-65`, `electron/resources/trayColor@2x.png` | PNG @2x at scaleFactor 2; Windows wants a multi-size `.ico` (16/20/24/32), blurry at 125/150% | P2 | win-shell-ui (visual) | screenshot at 100/150% |
| K-04 | Tray right-click | `tray-manager.ts` | No context menu (Show / Quit), expected on Windows | P2 | win-shell-ui (visual) | manual |

### Open in terminal

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| L-01 | Settings > System "open" | `electron/utils/open-terminal.ts:68-94` | No win32 branch: "Opening a terminal is not supported on win32". Deps are injectable already | P1 | win-platform | unit with `platform: 'win32'` deps (wt.exe -d, then powershell, then cmd), argv only |
| L-02 | Copy | `src/app/projects/page.tsx:605-607`, `src/types/electron.d.ts:1401` | "Reveal in Finder" | P2 | win-shell-ui (copy) | screenshot |

### Window, lifecycle, notifications, shortcuts

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| N-01 | Title bar | `electron/core/window-manager.ts:103` | `titleBarStyle: 'hiddenInset'` is macOS-only; on Windows a hidden title bar without `titleBarOverlay` shows **no window controls** (https://www.electronjs.org/docs/latest/api/structures/base-window-options) | P1 | win-shell-ui (visual) | screenshot with min/max/close |
| N-02 | Drag the window | `src/components/ClientLayout.tsx:248`, `Sidebar.tsx:169`, `src/app/globals.css:568-576` | Drag area is the 28 px top of the sidebar column only (sized for traffic lights) | P1 | win-shell-ui (visual) | manual drag; screenshot |
| N-03 | Closing the window | `electron/main.ts:733-737` + `:748-767` | `window-all-closed` quits on non-darwin, and `before-quit` kills every PTY: closing the window on Windows kills every agent (mac keeps them) | P1 | win-shell-ui (lifecycle decision) | E2E/manual: close window, agents' PTYs still alive, tray reopens |
| N-04 | Second launch | `electron/main.ts` (no `requestSingleInstanceLock`), `:740-745` (`activate`, mac only) | A second click on the shortcut starts a second Tars: API port 31415 taken (FATAL log), two writers on `~/.dorothy` | P1 | win-shell-ui | manual: second launch focuses the first |
| N-05 | Desktop notifications | `electron/main.ts` (no `app.setAppUserModelId`), `utils/index.ts:171` | Windows toasts need an AppUserModelID matching a Start Menu shortcut (https://www.electronjs.org/docs/latest/tutorial/notifications); must equal `build.appId` for NSIS | P1 | win-shell-ui + win-build | manual: a toast appears in dev and packaged |
| N-06 | Notification sound (security) | `electron/utils/index.ts:200-204` | `execFile('powershell', ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`])`: path interpolated into PowerShell code. The path comes from `app-settings.json` in `~/.dorothy`, a directory every agent is handed: a `'` in a file name runs code in the main process. Also `.wav` only | P1 | win-platform | failures-first unit: a path with `'` and `;` never reaches a script; argv or `-EncodedCommand` with the path as data |
| N-07 | Default menu accelerators | `electron/main.ts` (no `Menu.setApplicationMenu`) | Electron's default menu on Windows binds Ctrl+W (close window, then N-03 kills all agents), Ctrl+R (reload renderer), Ctrl+Shift+I (DevTools) even in the packaged build; Ctrl+W/Ctrl+R are everyday readline keys in a terminal pane. To verify | P1 | win-shell-ui | manual: Ctrl+W and Ctrl+R typed in an agent terminal reach the PTY |
| N-08 | Ctrl+digit | `src/components/Sidebar.tsx:109-120` vs `src/components/TerminalsView/hooks/useTerminalKeyboard.ts:37-44` | Sidebar listens to Meta **or** Ctrl + digit; terminals use Ctrl + digit. Distinct on mac (Cmd vs Ctrl), the same keys on Windows: both fire | P1 | win-shell-ui | E2E keypress on Dashboard: one action only |
| N-09 | Paste in terminals | `src/lib/terminal.ts:257-270` | Copy is Ctrl+Shift+C on Windows (ok); Ctrl+V paste behaviour in xterm under Windows unverified | P2 | win-shell-ui | manual |
| N-10 | `local-file://` | `window-manager.ts:268-292` | Standard scheme: `local-file:///C:/x` canonicalizes the drive as host, pathname loses `C:`. No caller in `src/` builds these URLs (dead path); containment itself fails closed (Q3) | P2 | win-shell-ui | unit on the URL to path mapping, or remove |
| N-11 | Port-in-use hint | `electron/services/api-server.ts:459` | `lsof -nP -iTCP:...` hint | P2 | win-shell-ui (copy) | `netstat -ano \| findstr :31415` on win32 |

### Renderer paths and copy

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| U-01 | Code panel file tree | `ipc-handlers.ts:2821` (`path.relative`), `src/components/AgentWorld/CodePanel.tsx:128`, `:423`, `:472` | Main returns `src\app\x.ts`, renderer splits on `/`: a flat list of backslash names | P1 | win-shell-ui (+ ipc-handlers returning POSIX-style relative paths) | E2E agent window code tab shows folders |
| U-02 | Project names everywhere | 34 `split('/').pop()` sites, e.g. `src/hooks/useAgentFiltering.ts:26`, `NewChatModal/index.tsx:35`, `KanbanCard.tsx:45`, `app/logs/page.tsx:60`, `app/review/page.tsx:79-82`, `Chat/bus-view.ts:394`, `app/chat/page.tsx:418`; main: `bus-store.ts:264` | Shows the whole `C:\Users\...` path as the project name (rooms, cards, filters) | P1 | win-shell-ui (one shared basename helper) | E2E surfaces with Windows seed paths |
| U-03 | CLI paths copy | `CLIPathsSection.tsx:144` | "separated by colons. /opt/homebrew/bin, /usr/local/bin and ~/.nvm are always included" | P2 | win-shell-ui (copy) | screenshot |
| U-04 | `~` shortening | `useAgentFiltering.ts:28`, `NewChatModal/AgentPanel.tsx:13`, `TeamPanel.tsx:12`, `Memory/AgentKnowledgeGraph.tsx:268` | Regex `/Users\|home`: no `~` on Windows | P2 | win-shell-ui | unit |
| U-05 | Template import | `src/lib/template-review.ts:209` | Obsidian folder must start with `/`: every Windows path refused | P2 | win-shell-ui | unit |
| U-06 | Mac copy | `GoogleWorkspaceSection.tsx:166` (`brew install`), `AgentList/DesktopRequiredMessage.tsx:24` ("Mac app"), `Settings/MemorySection.tsx:151` (`/Users/you`), `ClientLayout.tsx:360` ("On macOS...") | Wording | P2 | win-shell-ui (copy) | screenshots |
| U-07 | Misc path parsing | `Settings/NotificationsSection.tsx:28`, `Memory/AgentKnowledgeGraph.tsx:432`, `electron/utils/redact-secrets.ts:78` | `split('/')`, `startsWith('/')`; Windows paths are not seen as locations and get redacted | P2 | win-shell-ui / win-platform | unit |
| U-08 | Kanban task to agent matching | `electron/services/kanban-automation.ts:200-210` | Only strips trailing `/`, compares strings: `C:\x` vs `c:\x\` vs `C:/x` never match | P2 | win-platform (`samePath()`) | unit |

### Secrets and atomic writes

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| S-01 | Secret file modes | see Q5 list | Every `0o600`/`0o700`/`chmod` is a no-op on Windows (chmod maps to the read-only bit). Protection comes from the profile ACL only, nothing if a file lands outside `%USERPROFILE%` | P2 | win-platform | document in SECURITY.md; optional ACL check (`icacls`) unit |
| S-02 | Settings save, `~/.claude.json`, mcp.json, agents.json | `electron/utils/secret-file.ts:64-69` (`writeAtomicSync`), `electron/utils/shared-file.ts:47-90` (`updateSharedJsonSync`) | `renameSync` over a file another process holds open without FILE_SHARE_DELETE (Claude Code reading `~/.claude.json`, antivirus, an MCP server reading app-settings.json) fails EPERM/EBUSY on Windows; no retry | P1 | win-platform | stress test: 20 concurrent readers, 200 writes, zero failures |

### Packaging, release, auto-update

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| P-01 | Packaged build | `package.json:16`, `:25` | `bash -c 'set -e; rm -rf; mv; trap ...'`; `bash` here is the WSL launcher | P2 | win-build | `npm run electron:build` from PowerShell exit 0 |
| P-02 | Pack | `package.json:18` | `electron-builder --dir --mac` | P2 | win-build | `release\win-unpacked\Tars.exe` starts |
| P-03 | Installer | `package.json:28-140` `build` | No `win`/`nsis` section, no `.ico` (`build/` holds only the entitlements), default Electron icon; `asarUnpack` of node-pty covers conpty binaries (ok) | P2 | win-build | NSIS install, uninstall, upgrade on this machine |
| P-04 | Sandbox | `package.json:24`, `scripts/sandbox.sh` | Bash, `release/mac-arm64/Tars.app`, `CFFIXED_USER_HOME`, `nohup` | P2 | win-build | `npm run sandbox` starts `win-unpacked` with USERPROFILE sandbox on 31499 |
| P-05 | Design lint | `package.json:26`, `scripts/design-lint.sh` | Bash + GNU grep; part of the gate | P2 | win-build | `npm run lint:design` from PowerShell exit 0, and exit 1 on a planted hex |
| P-06 | Release | `scripts/release.mjs:211-300`, `:454` | `latest-mac.yml`, dmg/zip, `plutil`, `mac-arm64/Tars.app`; `spawnSync('npm', ...)` is ENOENT on Windows | P2 | win-build | `npm run release -- --dry-run` on Windows |
| P-07 | e2e:auto | `scripts/scope-checks.mjs:250` | `execFile('npx', ...)` ENOENT; its fallback does the same | P2 | win-build | `npm run e2e:auto` runs the suite |
| P-08 | README shots | `scripts/readme-shots.mjs:51` | `HOME` only | P2 | win-build | run with sandboxed USERPROFILE |
| P-09 | Auto-update | `package.json:31-35`, `electron/constants/index.ts:94`, `electron/services/update-checker.ts:79-82` | See Q4: `latest.yml` missing upstream, fallback offers the mac `.dmg` | P1 | win-build | packaged 1.x.0 updates to 1.x.1 from the fork, `latest.yml` served |
| P-10 | Update UX | `update-checker.ts`, `ClientLayout.tsx:360` | Unsigned NSIS: SmartScreen on first run; version scheme of fork builds vs upstream | P2 | win-build | release checklist |
| P-11 | CI | `.github/workflows/ci.yml:5-12` | ubuntu only, `branches: [main]` only (the fork's `windows` never runs), only `npm test` | P2 | win-build | matrix `windows-latest` green on a PR to `windows` |

### E2E

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| E-01 | Sandbox home (safety) | `e2e/fixture.mjs:556-591` | See section 0: HOME only; add USERPROFILE, APPDATA, LOCALAPPDATA, HOMEDRIVE/HOMEPATH and check `os.homedir()` and `DATA_DIR` in the "landed" assertion. Keep `CFFIXED_USER_HOME: sandboxHome` (asserted by `__tests__/e2e-sandboxed-launch.test.ts:47`). Whether Electron's `getPath('home'/'appData')` follow those variables on Windows is unverified | P0 | win-qa | launch fails if any path or homedir is outside the sandbox; negative witness with USERPROFILE unset |
| E-02 | Fake CLI | `fixture.mjs:617-627`, `agent-window-snapshot.spec.ts:45-49`, `terminal-replay-modes.spec.ts:43,84`, `terminal-wheel.spec.ts:36,92`, `terminal-wheel-reports.spec.ts:29,68` | `#!node` `.cjs` with mode 0o755 as `cliPath`: not executable on Windows, `settleFleet` times out. Blocks the gate | P2 | win-qa | surfaces suite reaches the first screenshot |
| E-03 | Visual baselines | `playwright.config.ts:21` | `snapshotPathTemplate` has no `{platform}`: Windows compares against the mac references | P2 | win-qa | `__screenshots__/win32/*` recorded, mac refs untouched |
| E-04 | Chat rooms temp dir | `e2e/chat-rooms.spec.ts:37` | `mkdtempSync('/tmp/...')` is `C:\tmp\...` (absent) | P2 | win-qa | spec green |
| E-05 | Live spec | `e2e/left-fullscreen.live.spec.ts:38`, `:45`, `:64`, `:288-296` | `which`, `/tmp`, `#!/bin/bash` wrapper, `pgrep`/`ps`, `SIGKILL` | P2 | win-qa | live spec green or explicitly skipped on win32 with reason |
| E-06 | Unreadable usage | `e2e/usage-unreadable.spec.ts:49` | `chmod 0o000` does not block reads on Windows | P2 | win-qa | ACL-based unreadable file, spec green |
| E-07 | Wheel spec env | `e2e/terminal-wheel.spec.ts:103` | `SHELL: '/bin/zsh'` | P2 | win-qa | spec green |

### Unit tests

| # | feature | path:line | Windows problem | P | owner | proof of fix |
|---|---|---|---|---|---|---|
| T-01 | Throwaway home (safety) | `__tests__/setup/home-isolation.ts:121`, `__tests__/setup/env-isolation.ts` (KEPT = HOME, SHELL) | HOME only; `os.homedir()` stays the real profile. Redirect USERPROFILE (+APPDATA/LOCALAPPDATA) before imports | P0 | win-qa | `home-isolation.test.ts` extended: `os.homedir()` equals the throwaway dir on win32 |
| T-02 | Tests that run `bash` | 14 files: `__tests__/hooks/*.test.ts` (7), `scripts/design-lint.test.ts`, `electron/providers/{effort-flag,exec-into-cli,managed-cli-env,prompt-operand}.test.ts`, `electron/utils/statusline-{token-stats,gnu-stat}.test.ts` | `spawn('bash')` resolves to `C:\Windows\System32\bash.exe` (WSL) before Git's | P2 | win-qa | decision per file (Git Bash path, or Node hooks) |
| T-03 | POSIX-bound tests | 132 of 253 files hold POSIX literals (paths, modes, signals, `.sh`, bash); 49 files / 128 `'/Users\|/tmp\|/home/'` literals; 37 files assert modes; 88 spawn real processes; only 6 files branch on platform | Expect a large red baseline; triage bug vs non-portable test | P2 | win-qa | triage table in WINDOWS-PORT.md |

## 2. Answers to the five questions

**(1) `~/.claude/projects/<encoded>`.** Claude Code's encoding is every non-alphanumeric character to
`-`: this very session's folder is `C--Users-nicol-Documents-Claude-Project-Tars` for
`C:\Users\nicol\Documents\Claude Project\Tars` (colon, backslash and space all became `-`).
In Tars:
- decode: `electron/utils/decode-project-path.ts:16-60`, used by `services/project-index.ts:40`, which
  feeds `ipc-handlers.ts:2343` (fs:list-projects), `:2443` (read-project-files roots),
  `claude-service.ts:262`, `memory-service.ts:99`. Measured with the compiled module:
  `C--Users-x-proj` gives `\C\Users\x\proj`; `C--Users-nicol-Documents-Claude-Project-Tars` gives
  `\C\Users\nicol\Documents\Claude\Project\Tars`. It starts from `/`, never produces `C:`, and its
  separator candidates are `-`, `.`, `_` only (spaces are lost on every platform).
- encode, wrong on Windows (`[/.]` only): `utils/resume-session.ts:24-26` (measured:
  `C:\Users\x\proj` unchanged, transcript path `...\projects\C:\Users\x\proj\<id>.jsonl`),
  `memory-service.ts:85-87`, `e2e/fixture.mjs:526`.
- encode, right: `memory-hub.ts:66-69` (tries `[^a-zA-Z0-9]` first) and `:416`.
- Tars's own names, not Claude's (harmless): `memory-routes.ts:31`, `memory-hub.ts:167`,
  `KanbanBoard/components/NewTaskModal.tsx:84`.
Fix direction: one `encodeClaudeProjectDir()` = `replace(/[^a-zA-Z0-9]/g, '-')`, and a decoder that
tries `X:` + `\` as the first segment on win32 and a space among separators.

**(2) Worktree guard on Windows** (`electron/utils/worktree-path.ts:21-46`). Sound against traversal:
`BRANCH_SHAPE` admits only `[A-Za-z0-9._/-]` starting alphanumeric, so no `\`, `:`, drive letter, UNC,
space or absolute path can enter; `..` and `//` are refused; containment is `path.resolve` then
`startsWith(root + path.sep)` on two strings built from the same `projectPath`, so case never differs.
Measured: `../x`, `a/../../x`, `feat\x`, `C:x`, `a:b`, `x/.. /y` all refused; UNC projects work
(`\\server\share\proj\.worktrees\feat\x`). Residual Windows-only weaknesses (P2, W-01): device names
(`CON`, `feat/nul`) are accepted and trailing-dot segments (`a./b`) alias another directory for Win32
APIs (Node's fs uses `\\?\` so it sees `a.` literally while git does not). Case-insensitive aliasing
(`Feat/X` vs `feat/x` share a folder and the "reuse existing worktree" branch) is the same on macOS's
default APFS. A junction planted as `.worktrees` is the same class as a symlink on mac.

**(3) `local-file://` and `app://`** (`window-manager.ts:233-360`), and `/api/local-file`
(`vault-routes.ts:283-296`). All three use `path.resolve` + `startsWith(root + path.sep)`:
- Backslash and `%5c`: `path.join`/`resolve` on win32 treat `\` as a separator and collapse `..`
  before the check, so `..%5c..%5c` is refused. `app://-/C:%5cWindows` joins to `<base>\C:\Windows`,
  inside the bundle and not found.
- Case: the comparison is case-sensitive while NTFS is not. That fails closed (a lower-case drive or
  an 8.3 short name is refused), never open.
- Win32 normalization (trailing dots/spaces, `.. `): Node passes `\\?\`-namespaced paths to the file
  system (measured `path.toNamespacedPath('C:\a\b\.. \c')` = `\\?\C:\a\b\.. \c`), so `.. ` is a
  literal name, not a parent. Sound.
- `\\?\C:\...` and `\\localhost\c$\...` inputs do not start with the root: refused.
- Weakness: `local-file://` is a standard scheme, so `local-file:///C:/x` loses the drive to the host
  part; nobody in `src/` builds such URLs, so it is dead on Windows (N-10). Links inside an allowed
  root (junction in a project or in `vault/attachments`) are followed; same as symlinks on mac, not a
  Windows regression.

**(4) Auto-update on Windows today.** `electron-updater` (`update-checker.ts`) reads the provider baked
from `build.publish` = GitHub `JeanBrasse/Tars` (`package.json:31-35`); the fallback uses
`GITHUB_REPO = 'JeanBrasse/Tars'` (`constants/index.ts:94`). An NSIS build asks for `latest.yml`;
upstream releases carry only `latest-mac.yml`, dmg and zip (release.mjs publishes nothing else), so
`checkForUpdates` throws, `checkGitHubRelease` compares versions against upstream's tag and, if newer,
offers `dmg || zip` as `downloadUrl` (`update-checker.ts:79-82`): a mac installer offered to a Windows
user. Nothing is auto-installed. To fix: fork-specific `publish` owner/repo and `GITHUB_REPO` (config,
not code), NSIS target producing `latest.yml` + blockmap, a Windows asset filter in the fallback, a
version scheme that does not collide with upstream tags. Unsigned NSIS updates install (no
`publisherName`), with SmartScreen on first run.

**(5) Secrets written with a POSIX mode** (all no-ops on Windows; protection = `%USERPROFILE%` ACL):
- `electron/utils/secret-file.ts:33` (dir 0700), `:34`/`:68` (temp file 0600, `wx`), `:39` chmod 0600,
  `:103-108` `ensureSecretFileMode`, `:125-143` `narrowDataDir` (0700 dirs, `& 0o700` files).
- Callers of `writeSecretFileSync`: `main.ts:238` (`app-settings.json`, every API key and bot token),
  `hermes-config.ts:40` (`hermes-connection.json`), `hermes-webhook-secret.ts:52`, `:79`
  (`~/.tars-private/hermes-webhook-secret`), `hermes-client.ts:83` (Hermes session cookies),
  `overseer-store.ts:152`, `:199`, `:206`, `:281` (Noah's super-chat conversation, Hermes sessions).
- `ensureSecretFileMode`: `main.ts:414-416` (app-settings, hermes-connection, api-token),
  `hermes-config.ts:26`, `:57`; `narrowDataDir(DATA_DIR)`: `main.ts:419`.
- `api-server.ts:110` `api-token` written directly with `{ mode: 0o600 }` (not atomic).
- Directories: `utils/index.ts:25` (`~/.dorothy` 0700), `overseer-store.ts:141` (`~/.tars-private`),
  `bus-files.ts:52`, `:103` (staged room files).
- `shared-file.ts:49`, `:77` (`~/.claude.json`, `~/.claude/settings.json`, `mcp.json` created 0600 or
  keeping the old mode).
- Audit A's side: hooks' `umask` logs and `statusline.ts:246` (0755).

## 3. Already cross-platform (extend, do not duplicate)

- `electron/utils/open-terminal.ts`: injectable `{platform, launch, execFile}`, argv only; add a
  `win32` branch.
- `electron/utils/index.ts:196-212` already branches on `win32` for sounds (the branch itself is N-06).
- `electron/preload.ts:846` exposes `platform` to the renderer; `ipc-handlers.ts:1829` returns it.
- `git-review.ts`, `agent-truth.ts:53`, worktree creation/removal (`ipc-handlers.ts:335-345`,
  `:1089-1095`, `:1209-1211`), `hermes-handlers.ts` `execFileAsync(bin, argv)`: argv, no shell.
- `transcript-usage.ts`, `usage-ledger.ts`: `path.join` walk, no decoding.
- `memory-hub.ts:66-69`, `:416`: already the correct `[^a-zA-Z0-9]` encoding.
- `path-identity.ts` (`isWithinDir`, `isHardLinkInto`): `realpathSync.native` + `dev`/`ino` works on
  NTFS (volume serial, file index); fails closed on precision loss. Used by `api-routes/utils.ts`,
  `vault-routes.ts`, and mirrored in `mcp-telegram` (its segment check lower-cases, and its realpath
  pass catches 8.3 short names).
- Containment helpers (`isUnder`, `withinRoot` `ipc-handlers.ts:2791-2795`, `isAllowedTextFile`,
  `isWithinVault`, `/api/local-file`): `path.resolve` + `path.sep`, fail closed on Windows.
- `worktree-path.ts`: sound on Windows (Q2).
- `hooks-manager.ts:62-85` `removeLegacyHookLogs`: no-op on Windows (`getuid` undefined), harmless.
- `window-manager.ts:127` `app.dock?.hide()` and `tray-manager.ts` `setTemplateImage(false)`: no-ops.
- `mcp-*`: servers use `os.homedir()` (follows USERPROFILE, same as the app), `path`, `fetch`; no
  shell, no POSIX binaries; registered as `node <resourcesPath>/.../bundle.js` (needs `node` on PATH,
  same as mac).
- `e2e/ports.mjs` offsets; ports 3100 and 31415-31499 are outside this machine's excluded ranges today
  (`netsh interface ipv4 show excludedportrange protocol=tcp`: 5357, 49713-50204, 55144+...).
- `next.config.ts`: cross-platform (only the npm scripts that set `ELECTRON_BUILD` are not).
- Line endings: `core.autocrlf=false`, `hooks/*.sh` are LF in the index and worktree.

## 4. Security-relevant findings (separate)

Windows-specific:
1. **N-06** PowerShell code built from the notification-sound path (`utils/index.ts:202`); the path is
   writable by any agent through `~/.dorothy/app-settings.json`. Main-process code execution.
2. **M-03** Telegram send-file guards (app and `mcp-telegram`) do not block `%APPDATA%` /
   `%LOCALAPPDATA%` credential stores or Tars's own Electron profile.
3. **S-01** Every 0600/0700 is a no-op; SECURITY.md must not claim it on Windows.
4. **E-01 / T-01** Test and E2E isolation point at the real profile until USERPROFILE is redirected
   (real tokens, real `~/.claude.json`).
5. **W-01** Worktree guard admits device names and trailing-dot aliases (low).
6. **A-11**, **C-05**, **A-08**, **A-09** Shell strings run through cmd.exe (argv rule); A-11 carries
   user text and project names (cmd drops everything after the first LF, which limits it today).

Pre-existing, not Windows-specific (report, do not fix in the port):
- `git-review.ts:318-331` `fileDiff` reads `path.join(repoPath, file)` for an "untracked" file with no
  containment: `file = '../../.ssh/id_rsa'` returns the key as a patch (renderer IPC only).
- `/api/local-file` (`vault-routes.ts:283-296`, no token) follows a symlink/junction planted inside
  `vault/attachments` (agents can write under `~/.dorothy`).

## 5. Visual / UX changes that need Nicolas

1. Title bar (N-01): `titleBarStyle: 'hidden'` + `titleBarOverlay` (colour/height matching the 84 px
   header), and where the native caption buttons sit over the header actions on the right.
2. Drag region (N-02): which strip drags the window on Windows.
3. Tray (K-01..K-04): panel above the taskbar, `.ico` icon, right-click menu (Show / Quit).
4. Lifecycle (N-03, N-04): close = hide to tray (agents keep running) vs quit; single instance.
5. Shortcuts (N-07, N-08, N-09): Ctrl+digit ownership, removing or replacing the default menu
   accelerators (Ctrl+W, Ctrl+R, Ctrl+Shift+I), Ctrl+V/Ctrl+Shift+V in terminals.
6. Copy: "separated by colons" + default dirs (U-03), "Reveal in Finder" (L-02), `brew install`,
   "Mac app", `/Users/you`, "On macOS" (U-06), lsof hint (N-11), project names (U-02), `~` paths (U-04).
7. Installer identity: NSIS icon and name, SmartScreen (P-03, P-10).

## 6. Open questions

1. Electron `app.getPath('home'|'appData')` on Windows: do they follow `USERPROFILE`/`APPDATA` env
   overrides (the E2E folder check depends on it)? Measure with a probe launch.
2. node-pty 1.1: ConPTY `pty.spawn('npx')` / `.cmd` resolution, and whether `-l` makes Windows
   PowerShell 5.1 exit; measure.
3. better-sqlite3 13 prebuilt for Electron 44 win32-x64 available through prebuild-install, given no
   VS Build Tools?
4. Hermes Desktop and Tasmania: do they exist on Windows, and where is their config?
5. Fork release scheme: version numbers and repo for the Windows update feed (Q4).
6. N-07: confirm Electron's default menu accelerators actually steal Ctrl+W/Ctrl+R from a focused
   xterm on Windows.

Sources: https://nodejs.org/api/os.html#oshomedir ; https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows (CVE-2024-27980, April 2024) ; https://www.electronjs.org/docs/latest/api/structures/base-window-options ; https://www.electronjs.org/docs/latest/tutorial/notifications (all read 2026-09-25).
