# Tars cloud: a headless Tars server, reached over SSH. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nicolas's cloud projects live on his Linux server, where a Tars without a window keeps their agents, terminals and conversations running 24/7, and every desktop Tars he opens (Mac, PC) shows them beside its local projects, sees and drives them, creates new ones there, and moves a local project there on one click; Hermes, on the same server, acts on them as an outside agent with its own credential.

**Architecture:** on a server, `require('electron')` answers a headless module (`electron/host/headless-electron.ts`, installed first by the server's entry; the desktop never loads it), so `tars-server serve` runs the core's own files unchanged under plain Node 22, no display: the same agent manager, PTYs, hooks and local API, as a systemd user service. The server adds a *door*: a second `node:http` listener bound to `127.0.0.1` only, admitting scoped client credentials minted on the server. A desktop reaches it with Nicolas's own SSH key: it starts the server if it is down, mints its credential over the SSH session, and forwards a local loopback port to the door; nothing new listens on any network, and no master token travels.

**Tech Stack:** Node 22 (`.nvmrc`) and Electron 44.9 main process (TypeScript, CommonJS, `tsc -p electron/tsconfig.json`), `node:http`, `node:crypto`, `node-pty` 1.1 (N-API: one binary serves Node and Electron), `better-sqlite3` 13 (built for Node by `npm ci`, rebuilt for Electron only by `electron-builder`), the system `ssh` client (OpenSSH on macOS, Windows and Linux) through `spawn` with an argv array, systemd user units, Next.js 16.4 renderer (React 19, xterm 5), vitest (its ubuntu CI job is the first Linux run of the core), Playwright, the `pen` CLI.

**Spec:** Nicolas's decisions of 2026-11-02, relayed by the orchestrator and copied into "Decisions" below; the non-negotiables of 2026-10-28 (Global Constraints). This plan supersedes `docs/superpowers/plans/2026-10-28-tars-cloud-step2.md` (pairing over the tailnet, hub and spokes, relay) and the web-door direction of `TARS-CLOUD.local.md` (2026-11-01). Prior art, read with `git show origin/win/machines:<path>` and retyped, never merged: `electron/services/machines/{fleet-share,fleet-source,remote-fleet}.ts`, the renderer's `MachineBadge`, `MachineStopReason`, `useRemoteAgents`, `useRemoteDrive`, `lib/machines.ts`, their tests, and `SECURITY.md` §8. Borrowed ideas (MIT, © 2026 T3 Tools Inc., cited in any file that adapts its code): T3 Code's `docs/internals/remote.md` (SSH launches and forwards; stop only a server the launcher started), `environment-auth.md` (scoped sessions, outside agents get a ceiling not a scope list, pairing secrets never readable back), `connection-runtime.md` (one retry owner, jittered backoff capped at 5 min), `packages/ssh/src/tunnel.ts` (forward options), `docs/user/remote-access.md` (Desktop-managed SSH, revoke on the host), `docs/user/portable-handoffs.md` (a budgeted excerpt, not a summary, 16,000 by default).

## Decisions (the spec, 2026-11-02)

1. **Projects are local or cloud.** Chosen at creation. A cloud project's files, agents, terminals and conversations live on the server and appear in every desktop Tars connected to it. A local project stays private to its machine. No relay: a desktop never shows another desktop's local projects.
2. **Move to cloud** on a local project: stop its agents, copy the whole folder (uncommitted work and `.env` included, over SSH only), recreate its agents with the same settings on the server; the local folder is kept aside, never deleted by Tars. Agents start a fresh conversation primed with a bounded excerpt of their recent messages.
3. **A real headless Tars server now**, no Electron, no Xvfb, a systemd service. The desktop behaves exactly as before.
4. **Connection over SSH**, desktop-managed: Nicolas's existing key (`ubuntu@100.101.245.29` today, the host configurable), a forward to the server bound on `127.0.0.1`, started by the desktop if it is down. No pairing protocol, no new Tailscale port, nothing listening on the network. The master API token never leaves its machine: each desktop holds a scoped, revocable credential minted on the server, and the server lists its clients.
5. **Scoped permissions per client:** see, drive, create (projects and agents), files. Hermes later becomes an outside-agent client with its own credential and a ceiling; it acts (start, stop, message, create), reports on Telegram, and its actions read "by Hermes" in Tars.
6. **Workflow:** built and tested on Nicolas's fork (`up/tars-cloud` from `upstream/main`), proven for real with server, Mac and PC, then proposed to Noah as small PRs he can test.

## Global Constraints

- **Nothing new listens on a network.** The door binds `127.0.0.1` only: never `0.0.0.0`, `::`, the tailnet address, `tailscale serve` or Funnel. A desktop's forward binds `127.0.0.1` on an ephemeral port. The door is reached through SSH or from the server itself (Hermes).
- **The master API token never leaves its machine.** The door admits one kind of credential: a client credential (32 random bytes, base64url, 43 characters), kept on the server as its sha256, compared with `timingSafeEqual`. It never accepts the master API token, an agent's token, Tars's pass or a Hermes secret, and the local API on 31415 never accepts a client credential.
- **Credentials are minted on the server only** (`tars-server clients add`, run over the desktop's SSH session or on the server), printed once on stdout as one JSON line, never written to a log, never readable back: `clients list` shows ids, names, kinds, scopes and dates, never a credential or a hash. Revoking one cuts its open streams at once.
- **The server decides.** Each request is checked against the client's scopes read from the file at the request's head and again once its body is in; the `youMay` a client receives only shapes its window. Scopes: `see`, `drive`, `create`, `files`. An `outside-agent` client (Hermes) never types keys or sets a size, whatever its scopes: those are a person at a keyboard.
- **Drive is a shell on the server.** Typing into a terminal reaches the CLI's `!`; SECURITY.md says so, and SSH access, not the credential, is the real authority over a server: anyone who can `ssh` there can mint a credential.
- **SSH:** the system `ssh` through `spawn` with an argv array, never a shell on the desktop; `-o BatchMode=yes` (no hidden prompt); never `StrictHostKeyChecking=no` (an unknown host key fails with the sentence telling the user to run `ssh <host>` once in a terminal); the host is `[user@]host` or an SSH alias, refused if it starts with `-` or holds whitespace or controls, and always follows `--`; no user string ever reaches the remote command line: what a remote command needs travels on its stdin as JSON.
- **The desktop never stops the server.** Agents run 24/7; disconnecting, forgetting, quitting or crashing a desktop leaves the server and its agents running. "Start if down" goes through the server's own launcher (`systemctl --user start tars-server`), or `tars-server serve` detached when no unit is installed.
- **Off by default, desktop unchanged.** A desktop with no server configured makes no SSH call and shows nothing new beyond its settings section; the host seam changes no behaviour: every existing E2E surface keeps its reference screenshot and the full suite stays green.
- **The server:** runs as a non-root user; Node 22; `node-pty` needs a compiler there (no Linux prebuild); same `DATA_DIR` and `PRIVATE_DIR` as a desktop (`electron/constants`), under the service user's HOME; it refuses a data folder another Tars is using.
- **Secrets on disk:** `cloud-clients.json`, `cloud-server.json` (server) and `cloud-link.json` (desktop) live in `PRIVATE_DIR`, written with `writeSecretFileSync` (`0600` in `0700`, an owner-only ACL on Windows), never handed to a CLI, never sent to the window.
- **Do not touch Nicolas's server** until he says so: no SSH command against it, read-only included. M1 is proven locally and on the ubuntu CI job.
- **Upstream shape:** new code in new files (`electron/host/`, `electron/server/`, `electron/services/cloud/`, `electron/services/cloud-link/`, `electron/handlers/cloud-handlers.ts`, `src/components/Settings/CloudSection.tsx`, `src/lib/cloud.ts`, `src/hooks/useCloud.ts`); edits to upstream files are wiring, except the seam (Tasks 2 and 3), which is mechanical. `preload.ts` and `src/types/electron.d.ts` in the same commit. `execFile`/`spawn` with argv arrays. No `if (win32)` outside `electron/platform/`.
- **Pencil first** for every new or changed surface, through the `pen` CLI, shown to Nicolas before its TSX; new surfaces into `design/UI-INVENTORY.md` and `e2e/surfaces.mjs` in the same change.
- **Every upstream PR carries** its changelog entry and version bump, the docs it falsifies (`README.md`, `SPECS.md`, `OPERATIONS.md`, `DESIGN.md`, `SECURITY.md`), screenshots when a surface changed. Copy in English, no em or en dash (`npm run check:dashes`), `npm run check:names` clean, controls 26 or 32 px, tokens only.
- **Tests:** E2E first with its artefact (`E2E_TRACE=on`, screenshots, the JSON of asserted values, the reproducing command); units written failures first with the failure list in the test file's header; each test shown to bite (a mutant or the old build turns it red).
- **Git:** branches from `upstream/main` only. Never merge, rebase onto or cherry-pick from `windows`, `win/*` or any branch of the fork's old history. Before every commit `git config user.email` and after it `git log -1 --format='%an <%ae>'` show `91372699+Nexarion434@users.noreply.github.com`. Push to `origin` (the fork) only; nothing reaches `cooper-labs-tech/Tars` without Nicolas's explicit go for that action. T3 Code's code is MIT: a file adapting it names the source file and the license in its header.
- **This Windows PC:** no vitest mutants or E2E beside `npm test` (load times out unrelated files); a symlink test failing with EPERM is checked on the CI Windows job first; a green `Tests` line with an `Unhandled Errors` block is a failure; the server's own vitest specs pick ports away from the running Tars (31415, 31416).

## Review Focus

1. **The server restarts while agents run** (systemd restart, reboot, an update): agents come back through restart recovery as they do at a desktop's relaunch, and a connected desktop shows the offline line, then the same panes again, not a second copy. Pinned in Task 8 (`agents come back after the server restarts`) and M2 (`reattaches a watched pane once after offline`).
2. **The SSH link drops** (hotel Wi-Fi, a laptop asleep, a phone's hotspot): the desktop marks the server offline within 45 s, retries with jittered backoff capped at 5 min, keeps one `ssh` process per server at most, and never stops the server. Pinned in M2 (`one forward per server at most`, `a dropped link stops nothing on the server`).
3. **A server and a desktop share a HOME** (someone runs `tars-server serve` on the Mac beside its desktop Tars): the server refuses to start, naming the Tars that holds the folder, instead of two processes writing `agents.json`. Pinned in Task 4 (`refuses a data folder another Tars uses`).
4. **A credential revoked while its desktop is connected:** the next request is a 401, the desktop reads "Disconnected by <server>" with Reconnect, never mints a new credential by itself, and every stream that client held ends at the revoke. Pinned in Task 6 (`revoke cuts that client's streams at once`) and M2 (`a 401 reads as disconnected, not offline`).
5. **Keys typed while the link is slow or failing:** batches leave in order, one at a time; a batch the server refused or never answered shows as not sent, and nothing typed after it goes ahead of it. Pinned in M2 (`keys keep their order and stop at the first failure`).

---

## How the pieces fit

| Role | What runs | Listens on | Holds |
|---|---|---|---|
| Server | `tars-server serve` (plain Node, systemd user unit, non-root user) | `127.0.0.1:31415` (local API, as today), `127.0.0.1:31417` (the door: `CLOUD_DOOR_PORT = API_PORT + 2`, so `DOROTHY_API_PORT` offsets move it) | its master API token (never leaves), `cloud-server.json` (its id and name), `cloud-clients.json` (clients and hashes) |
| Desktop | Tars as today, plus a cloud link when a server is configured | nothing new beyond `127.0.0.1:<ephemeral>` while a forward is up | its own master token (never leaves), `cloud-link.json` (host, server id, client id, credential) |
| Hermes (M5) | its own process on the server | nothing | its own client credential, used on `127.0.0.1:31417` directly |

**The seam.** Measured on `upstream/main` (dc623b59): 46 of 301 non-test files under `electron/` import `electron`; walking value imports from the core (`api-server`, `agent-manager`, `pty-manager`, `telegram-bot`, `mcp-orchestrator`, `hooks-manager`) reaches 228 modules and 15 of those 46 (`core/{agent-manager,pty-manager,window-manager,edit-context-menu}.ts`, `handlers/chat-handlers.ts`, `services/{api-server,mcp-orchestrator,state-mod,telegram-bot}.ts`, `services/api-routes/{agent-routes,types}.ts`, `utils/{broadcast,hooks-path,index,mcp-node}.ts`). None of them calls Electron at load; inside functions they use `app` (`getAppPath`, `getPath`, `isPackaged`, `getVersion`, `once`, `exit`, `whenReady`, `focus`, `dock`), `BrowserWindow` (`getAllWindows`, `fromWebContents`, `new`), `Notification`, `ipcMain.handle`, and, in window code the server never runs, `protocol`, `shell`, `Menu`. The core already copes with `mainWindow === null` (a macOS Tars runs with every window closed), so a server is "a desktop whose window never opens".

**Plan change (measured while executing Task 1, 2026-11-02):** the first version of this plan routed those 12 core files through a `host()` call. But 136 test files mock `electron` and import one of those modules directly, many asserting through the mocked `app` or `BrowserWindow`: a `host()` seam would have meant editing a large share of them, and touching 12 core files. The seam is instead the `electron` module itself: the server answers `require('electron')` with `createHeadlessElectron(...)`, and the core, its tests and the desktop stay exactly as they are. Requiring Electron's own npm package is avoided on a server for a second reason: with Electron 44, loading it downloads Electron's binary when it is missing (seen in this worktree).

| `electron` member | Desktop | Server (`headless-electron.ts`) |
|---|---|---|
| `app.getAppPath()` | the app | the install root (where `hooks/`, `skills/`, `mcp-*/dist` live), which also makes the `app.asar` rewrites a no-op |
| `app.getPath(name)` | Electron's | `userData`: `$XDG_STATE_HOME/tars-server` when absolute, else `~/.local/state/tars-server`; `home`, `temp`, `appData`, `logs`; any other name throws naming it |
| `app.isPackaged` | Electron's | `true` unless started with `--dev`, so the overrides a packaged Tars refuses stay refused on a server |
| `app.getVersion()`, `getName()` | Electron's | the install root's `package.json`, `tars-server` |
| `app.whenReady()`, `isReady()`, `on`, `once`, `quit()`, `exit(code)` | Electron's | ready at once; `quit()` runs `before-quit` then `will-quit` listeners, either can prevent it, as the shutdown steps do; `exit` ends the process |
| `BrowserWindow` | windows | none to find (`getAllWindows()` is `[]`, `fromWebContents` and `getFocusedWindow` `null`), `new BrowserWindow()` throws |
| `Notification` | system notifications | `isSupported()` false; `show()` writes a line to the log (Telegram and Hermes already reach the phone) |
| `ipcMain` | the renderer's calls | handlers accepted, never called |
| `dialog`, `shell`, `Menu`, `Tray`, `protocol`, `screen`, `clipboard`, `nativeImage`, `powerSaveBlocker`, `safeStorage` | Electron's | any call throws `A headless Tars has no <name>`: a window-only path reached on a server is loud |

Broadcasts to windows vanish on a server (no window); the door gets agent output from `onAgentOutput` (Task 6), not from IPC.

**Native modules.** `node-pty` 1.1.0 is an N-API addon: the same binary loads in Node and Electron (prebuilds for darwin and win32; on Linux it compiles at `npm ci`, so the server needs `build-essential` and `python3`). `better-sqlite3` 13.0.3 is installed for Node by `npm ci` (measured: both load under plain Node 24 from this worktree) and rebuilt for Electron only by `electron-builder` at packaging. The server installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, then `tsc -p electron/tsconfig.json` and the `mcp-*` builds, and runs `node electron/dist/server/cli.js serve`. No rebuild step is added for the desktop.

**The connection (M2), adapted from T3 Code's Desktop-managed SSH.** On Connect, the desktop's main process runs, each as one `ssh -o BatchMode=yes -- <host> <fixed command>`:
1. `tars-server status --json` → `{ running, doorPort, serverId, name, version }`; if not running, `tars-server start --json` (the systemd unit, or a detached `serve` marked as started by a desktop) and `status` again.
2. Once per server, `tars-server clients add --json`, with `{ name, kind: 'desktop', scopes }` on stdin → `{ id, credential, serverId }`, kept in `cloud-link.json`. Reconnecting reuses it. A 401 later is "Disconnected by <server>": Reconnect mints again only on the user's click.
3. The forward: `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -n -N -L 127.0.0.1:<local>:<door socket path> -- <host>` (T3's `startSshTunnel` options).
4. `GET /cloud/v1/hello` through the forward must answer the expected `serverId` before the credential is ever sent; then the fleet poll (every 3 s, one in flight), one SSE stream per open pane, and POSTs for actions, all from the desktop's main process, never from the window.
5. Forget: `tars-server clients revoke <own id>` over SSH, then the local file is cleared. Revoking another client is done the same way from Settings, or on the server.

**What is reused, what is new.**

| Piece | Source | In this plan |
|---|---|---|
| Fleet sharing field by field | `win/machines` `fleet-share.ts` | ported (Task 6); no machine id in routes, there is no relay |
| Fleet, screens, live output | `win/machines` `fleet-source.ts` (read half) | ported (Task 6), plus `onAgentOutput`, which upstream lacks |
| Drive executor | `win/machines` `fleet-source.ts` (drive half) | `executeDrive(request, caller)`, transport-agnostic (Task 7) |
| Sender line | `{ kind: 'machine' }` and its 8 readers (old plan Task 13) | ported with every reader (Task 7) |
| Remote fleet poller | `win/machines` `remote-fleet.ts` | ported in M2; remote ids `c:<serverId>:<agentId>` |
| Renderer | `MachineBadge`, `MachineStopReason`, `useRemoteAgents`, `useRemoteDrive`, `lib/machines.ts`, `keyQueue`, size follows the viewing pane, See panes scale | ported in M2 |
| Pairing protocol, tailnet bridge, Tailscale status move, ACL port, Xvfb spike, relay | `win/machines`, old plan | dropped |
| Host seam, headless entry, systemd unit, client credentials, door, SSH link, cloud projects, Move to cloud, handoff excerpt, outside agents | | new |

## Milestones and estimates

Working time for one implementing agent, with the upstream gates and one security review round per milestone; Nicolas's review waits are not counted.

| Milestone | What Nicolas gets | Estimate |
|---|---|---|
| **M1** headless server, proven locally (Tasks 1 to 8, detailed below) | `tars-server serve` under plain Node on this PC and on the ubuntu CI job; a test client sees and drives its agents through the door; the desktop unchanged | 5.5 to 7 days |
| **M2** desktop connects over SSH, sees and drives (outline) | Settings > Cloud; the server's agents in Dashboard and Agents with a badge, filter, offline line, live terminal, typing, size, start, stop with a reason, message; installed on the real server with his go; real test server + Mac + PC | 4 to 5 days, plus 0.5 day install and 0.5 to 1 day real test |
| **M3** create a cloud project or agent (outline) | New project asks Local or Cloud; new agents in a cloud project start on the server | 2.5 to 3.5 days |
| **M4** move a project to the cloud (outline) | the button, the copy over SSH, agents recreated with the same settings and a bounded excerpt | 3 to 4 days |
| **M5** Hermes as an outside agent (outline) | Hermes starts, stops, messages and creates with its own credential and ceiling, "by Hermes" in Tars | 2 to 3 days on the Tars side |
| **Upstream shaping** | the PRs below cut from the working whole, each with its gates | 2 to 3 days |
| | **Total** | **20 to 27 days** |

M2 to M5 each get their own detailed plan (same format) once the milestone before them is green, so they are written against code that exists.

## Upstream PR split (after the real test)

Each branch is cut from `upstream/main` and takes its PR's commits from `up/tars-cloud` (a clean history from `upstream/main`, so cherry-picking from it is allowed; never from the old-history branches).

1. `refactor: a headless electron, and main.ts without a window` (Tasks 1 to 3): no behaviour change. The one Noah must agree with first: it answers `require('electron')` with another module on a server, and skips `main.ts`'s window steps there. Recommended: an issue describing it once M1 is proven, before M2's UI, on Nicolas's go.
2. `feat: run tars without a window, as a server` (Task 4).
3. `feat: clients of a tars server, and what they may see` (Tasks 5 and 6).
4. `feat: drive a tars server's agents from a client` (Task 7).
5. `feat: connect this tars to a tars server over ssh` (M2, main process and Settings).
6. `feat: a tars server's agents in dashboard and agents` (M2, renderer).
7. `feat: create a project in the cloud` (M3).
8. `feat: move a project to the cloud` (M4).
9. `feat: hermes as an outside agent of a tars server` (M5).

## Security review gate

Critical lane, per milestone, in this order:
1. Self-check against the Global Constraints and SECURITY.md §2 and §5, written into the milestone's report: every listener with its address, every route with who it admits, every file with where it lives and its mode, every SSH command with its argv.
2. One fresh security reviewer (one subagent on the most capable model, not a swarm) reads the diff against: exposure beyond loopback; a route reachable without a credential or above its scopes; a credential, hash or master token reaching a log, a CLI's argv, the window or the remote command line; scopes enforced anywhere but the server, or read only before the body; text typed into a PTY without the sanitising every message gets (paste end, look-alike sender lines); resource exhaustion (body size, streams per client, slow readers, poll pile-up, `ssh` processes per server); remote strings rendered with controls or format characters; a cloud id resolved by local IPC; for M4, a tar entry escaping its folder. Blocking findings fixed and read again until clean; nits to the follow-up list.
3. The full gate once per milestone: both `tsc`, `npm test`, `npm run lint`, `npm run lint:design`, `npm run check:names`, `npm run check:dashes`, `npm run e2e:guard`, `npm run e2e:auto`, the milestone's own specs with their artefacts and mutants.
4. After M2, and again after M4, a whole-feature review of everything so far.
5. Nothing leaves the fork, and nothing runs on the server, without Nicolas's explicit go for that action.

## Decisions only Nicolas can make (before the step that needs them)

1. **Which user runs the server** (before M2's install). Leading option now: a Docker container (M2, install), which is a separate user by itself. Without Docker, recommended: a dedicated non-root user `tars`, his key added to it, a systemd user unit with `loginctl enable-linger tars`. Agents with full permissions then cannot read Hermes's or n8n's files, and Tars's hooks do not land in the `~/.claude/settings.json` of the Claude Code he runs in tmux as `ubuntu`. The host becomes `tars@100.101.245.29`.
2. **When the server may be touched.** Recommended: one install session after M1 is green on CI, each command announced first (user, Node 22, `build-essential`, the unit, `claude` login for that user), then the memory measured beside Hermes, n8n and his tmux sessions.
3. **The server's settings and provider keys.** The server has no window to set them. Recommended: on first connect, an explicit "Copy my provider settings to the server" (keys over SSH only, never the master token, never automatic); each CLI's own login done once on the server. Telegram, Slack and Discord bots run in one place only (two pollers on one bot token fight): the server, once it is live.
4. **The phone.** The SSH choice drops the browser and phone client of `TARS-CLOUD.local.md` (2026-11-01). Recommended: Hermes on Telegram is the phone path for now (M5); a web door can come later on the same server and credentials, additive.
5. **What Move to cloud copies** (before M4). Recommended: everything, uncommitted work and `.env` included, except dependency folders built for this machine (`node_modules` and the like), listed in the dialog and editable; the local folder renamed `<name> (moved to cloud YYYY-MM-DD)`.
6. **Telling Noah.** Recommended: the issue for PR 1 once M1 is proven, on his go.

---

## File Structure (M1)

| File | Responsibility |
|---|---|
| `electron/host/headless-electron.ts` (new, Task 1, done) | `createHeadlessElectron`: the `electron` a server loads |
| `electron/host/install-headless.ts` (new, Task 1, done) | `installHeadlessElectron`: `require('electron')` answers it, Electron's package never loaded |
| `electron/host/headless.ts` (new, Task 3) | `HEADLESS` |
| `electron/main.ts` (Task 3) | `if (!HEADLESS)` around the window steps, in place |
| `electron/server/main.ts`, `cli.ts`, `lock.ts` (new) | the headless entry, `serve`, `start`, `status`, `clients`; the data-folder claim |
| `electron/constants/index.ts` | `CLOUD_DOOR_PORT` |
| `electron/services/cloud/types.ts`, `clients.ts`, `server-identity.ts` (new) | scopes, clients, the credential store, the server's id and name |
| `electron/services/cloud/door.ts`, `fleet-share.ts`, `fleet-source.ts`, `drive.ts` (new) | the door and its routes |
| `electron/core/agent-manager.ts` | `onAgentOutput` |
| `electron/core/pty-manager.ts` and the sender line's readers | `{ kind: 'machine'; name }` |
| `scripts/tars-server.service`, `scripts/server-install.sh` (new) | the systemd user unit and the install steps OPERATIONS.md walks through; run on the server only with Nicolas's go |
| `__tests__/electron/host/*`, `__tests__/electron/cloud/*`, `__tests__/electron/server/*`, `__tests__/fixtures/no-electron.cjs` (new) | units, the graph test, the server spec |
| `SECURITY.md`, `OPERATIONS.md`, `SPECS.md` | "The Tars server and its clients"; "Run a Tars server" |

---

## M1: a headless Tars server, proven locally

### Task 1: The headless electron (done, see the plan change above)

**Files:**
- Create: `electron/host/headless-electron.ts`, `electron/host/install-headless.ts`
- Test: `__tests__/electron/host/headless-electron.test.ts`

**Interfaces:**
- Produces:
  - `createHeadlessElectron(opts: { root: string; dev: boolean; log: (line: string) => void; exit: (code: number) => void })` returning `{ app, BrowserWindow, Notification, ipcMain, dialog, shell, Menu, MenuItem, Tray, protocol, screen, clipboard, nativeImage, powerSaveBlocker, safeStorage }` as the table above says; `export type HeadlessElectron`
  - `installHeadlessElectron(electron: HeadlessElectron): () => void` (resolves `electron` to the id `tars:headless-electron` served from the require cache; a second install throws; the returned function uninstalls)

- [x] **Step 1: Write the failing tests.** Header: userData outside `$XDG_STATE_HOME/tars-server`, or a relative `XDG_STATE_HOME` used; an unknown `getPath` name answered; `isPackaged` false without `--dev`; the version read elsewhere than the root's `package.json`; a `before-quit` listener not run, run twice, or a prevented quit exiting; a window found, made or focused; a notification throwing or leaving no log line; `dialog`, `shell`, `Menu`, `protocol`, `Tray`, `screen`, `clipboard` answering; the install hook not answering `require('electron')`, installed twice, or left behind.
- [x] **Step 2:** `npx vitest run __tests__/electron/host`: FAIL (module missing).
- [x] **Step 3:** implement.
- [x] **Step 4:** PASS, 19 of 19. Bites: `stateHome()` taking a relative `XDG_STATE_HOME` turns `ignores a relative XDG_STATE_HOME` red.
- [x] **Step 5:** commit `feat: a headless electron for a tars server`.

### Task 2: The server's graph asks only what the headless electron answers (done)

**Files:**
- Create: `__tests__/electron/host/server-graph.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `CORE_ROOTS` in the test (the six roots measured above; Task 4 adds `electron/server/main.ts`).

- [x] **Step 1: Write the failing tests.** The walk follows value imports (not `import type`) from `CORE_ROOTS` through relative specifiers, collects every `<member>.<name>` and `new <member>` used on an `electron` import in the files it reaches, and fails on any the headless electron does not answer (`app` and `BrowserWindow` members it lacks, or a member of `Menu`, `shell`, `protocol` and the like outside the window files the server never calls: `core/window-manager.ts`, `core/edit-context-menu.ts`, `handlers/chat-handlers.ts`), printing the chain that reaches it. A second case finds any `electron` member used at module scope, read statically too (importing 228 modules would run their own load-time side effects). Header: a new `electron` member used by the core and missing here; an `electron` call at module scope; a dynamic `import('electron')` or `require('electron')` missed by the walk.
- [x] **Step 2:** done as a permanent case (`names a member it lacks`, removing `app.getAppPath`); also shown by hand: `getVersion` renamed in headless-electron.ts turns two cases red, naming `agent-routes.ts:2132` and its chain. Run it against a headless electron with `app.getAppPath` removed. Expected: FAIL naming `app.getAppPath` and its chain (the test must be shown to bite before it can pass).
- [x] **Step 3:** no product change was needed (measured: 228 modules, 15 import electron by value, 11 use its members, none at load, no dynamic require); a member the walk finds missing is added to `headless-electron.ts` with its own failing case in Task 1's test file first.
- [x] **Step 4:** PASS, 5 of 5.
- [x] **Step 5:** commit `test: the core asks a server's electron only what it answers`.

### Task 3: `main.ts` runs without a window (code done; the E2E comparison pending)

**Plan change (measured at the start of Task 3, 2026-11-02):** the first version moved the core's calls into one `startCore()`, "in the same order". Read in full, `main.ts`'s `app.whenReady` body (lines 539 to 805) interleaves the two all the way down: `loadAgents`, then `startHealthMonitor`, `startAgentAutosave`, `setupProtocolHandler`, `createWindow`, `installDesktopShell`, `initTray`, the IPC handlers, `setAccountEnvResolver`, more handlers, `startOverseerWatch`, `initVaultDb`, more handlers, the relays, the bots, the API, recovery, the watches, the MCP setup, the hooks, the updater, the CLI updates; and its steps share `main.ts`'s own `appSettings`, `errorReports` and `previousRun`. One function cannot keep that order, and moving 270 lines is the riskiest diff of M1. Instead, `main.ts` stays the one composition root for both: a server loads it under the headless electron, and only the steps the headless electron refuses are skipped there, each in place, so the order of everything else is the desktop's by construction. IPC handlers need no guard: the headless `ipcMain` accepts them and nothing calls them.

**Files:**
- Create: `electron/host/headless.ts` (`isHeadless(versions = process.versions, electronApp = app)`: plain Node **and** the headless electron's marker `app.headless === true`. Measured while writing it: three suites import `main.ts` under plain Node with a mocked `electron` (`error-report-start*.test.ts`, `error-report-windows-off.test.ts`); `process.versions.electron` alone would have sent them down the server's path)
- Modify: `electron/main.ts`: `if (!HEADLESS)` around, in place: `registerProtocolSchemes`, `setupProtocolHandler`, `createWindow` and `uncaught.windowOpened`, `installDesktopShell`, `initTray`, the `nodeMissing` dialog (a log line instead on a server), `initAutoUpdater` and the update checks, and whatever Task 4's boot finds refusing (each added with its failing case first)
- Test: `__tests__/electron/host/main-headless.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `isHeadless()`; `const HEADLESS = isHeadless()` in `main.ts`; `app.headless: true` on the headless electron; `WINDOW_STEPS` and `CORE_STEPS` in the test.

- [x] **Step 1: Write the failing tests.** Read `main.ts` with the TypeScript parser: each call in `WINDOW_STEPS` sits inside an `if (!HEADLESS)` block, and no other statement does (a guard around a core step would drop it from the server silently). Header: a window step unguarded (a server would throw at boot); a core step guarded; `HEADLESS` true in an Electron process (it reads `process.versions.electron`, which every Electron process has).
- [x] **Step 2:** FAIL (no `host/headless.ts`, no marker).
- [x] **Step 3:** the guards, in place: `registerProtocolSchemes`, `setupProtocolHandler`, `createWindow` with `uncaught.windowOpened`, `installDesktopShell`, `initTray`, the `nodeMissing` dialog, the updater block (`initAutoUpdater` to the timer). Nothing moved.
- [x] **Step 4:** PASS, 31 of 31 in `__tests__/electron/host`. Bites both ways: `initTray` unguarded names `initTray at main.ts:665`; `startAgentAutosave` guarded names `startAgentAutosave at main.ts:631`.
- [x] **Step 4b:** `__tests__/electron/core/uncaught-guard.test.ts` read `createWindow(); uncaught.windowOpened();` at two spaces exactly; it now takes the guarded block's four too (same block, nothing between: a line slipped in still turns it red).
- [ ] **Step 5: The desktop is unchanged.** Status 2026-11-02: units done (below); E2E BEFORE recorded for tests 1 to 117 of 319 (36 ok, the rest failed or skipped on this PC, live specs skipped), in `~/.tars/project-files/tars-b624a5a880/reports/tars-cloud-e2e-before-44b27917.txt`; tests 118 to 319 BEFORE and the whole AFTER run remain. The BEFORE build is the AFTER code with `git show 44b27917:electron/main.ts` compiled in its place. Units: after Task 3, 35 files / 133 tests failing and 6 Unhandled Errors, against 36 / 135 / 6 at c05fe239; one new failure, `uncaught-guard` 8, 9 (Step 4b, fixed); five baseline failures passed this time (flaky here: `orchestrator-for-a-message` 5, `review-repositories` R5, `save-worktree-work` 8, `vault-attach-private-dir`). On this PC, nothing else running tests: `npm test` and `npm run e2e` (148 spec files, 319 tests, one worker: about 30 to 50 s a test here, so one full run takes hours and does not fit in one delegated turn of an hour), each compared with the same runs at the commit before Task 3, never with zero (upstream has known Windows failures and this PC's symlink EPERM tests); a new failure or a moved screenshot blocks; an `Unhandled Errors` block counts as a failure. Then a dev run: agents start, the tray, a notification, quit and relaunch with restart recovery.
- [ ] **Step 6:** commit `refactor: main.ts skips its window steps when there is no window`.

Task 4 then shrinks: `electron/server/main.ts` installs the headless electron and requires `../main`; its spec is the first proof that the whole boot runs headless. Known risk for that boot: modules that read Electron at their own load (`@sentry/electron/main` behind `startErrorReports`, `electron-updater`); each found is answered in `headless-electron.ts` or guarded, failing case first.

### Task 4: `tars-server`: the entry, its CLI, its lock

**Status 2026-11-02: split in two.** **4a done:** `electron/server/main.ts` installs the headless electron, sets `process.resourcesPath` to the install root when Electron has not (a packaged Tars finds its MCP bundles there), turns SIGTERM and SIGINT into `app.quit()`, then imports `../main`; `electron/tsconfig.json` now includes `host/` and `server/` (it lists folders, and only `host/headless.ts` was reached through `main.ts`). `__tests__/electron/server/serve.test.ts` compiles the main process (CI's unit job does not build `electron/dist`), starts `node -r __tests__/fixtures/no-electron.cjs electron/dist/server/main.js` in the suite's own HOME on a free API port, and waits for `App initialization complete` and a 200 on `/api/health`; the SIGTERM case runs on POSIX only (a Windows signal is a hard kill). Measured: the whole `main.ts` boots headless, Electron's package never loaded; `@sentry/electron` and `electron-updater` did not trip it (error reports are off by default, the updater is guarded). Bites: `initTray` unguarded ends the boot with `A headless Tars has no nativeImage: nativeImage.createFromPath was called`. `server-graph.test.ts` keeps its six roots: from `server/main.ts` the walk reaches every handler file, whose window calls only a window ever makes, so the boot test is the proof there. **4b done:** `lock.ts` (`claimDataFolder`: refuses while a live server's pid holds `PRIVATE_DIR/server.json`, or while a Tars answers `/api/health` on the folder's API port, and then writes nothing; takes over a dead server's record; writes `{ pid, apiPort, version, startedAt, startedBy }` at 0600; `release()` leaves another process's record), `start.ts` (`startServer`: nothing when one runs, the systemd unit when installed, else a detached `serve` logging to `DATA_DIR/logs/server.log`; fails in words when nothing came up in 60 s), `cli.ts` (`serve [--dev]`, `start [--json]`, `status [--json]`: one JSON line on stdout, the rest on stderr), the claim in `server/main.ts` before `main.ts` loads. Scripts in `scripts/server/`: `build.sh` (Node 22.12 check, the compiler tools node-pty needs named with the `apt-get` line for root, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, the main build, every `mcp-*` found: upstream has since dropped `mcp-telegram`, so no fixed list), `tars-server.service` (a template: `@NODE@`, `@ROOT@`, `@PATH@` filled at install, `Restart=on-failure`, `TimeoutStopSec=30`), `install-user-unit.sh` (refuses root, enables the unit, prints the `loginctl enable-linger` line for root). **Docker fits as is:** a Dockerfile RUNs `build.sh` and has `node electron/dist/server/cli.js serve` as its entry (foreground, SIGTERM is Tars's quit); the unit is not used there; `start` then means `docker start` from the SSH side (M2); `server.json` lives in the HOME volume, so `status` works through `docker exec`. Tests: `lock.test.ts` 10 (plus the 0600 case on POSIX), `serve.test.ts` 4 (boot, SIGTERM on POSIX, the refusal, `status --json`); a probe that never sees a Tars turns the refusal red. Not tested here: the scripts (`sh -n` only), proven by the server trial in M2. Left for later: the desktop does not read `server.json`, so a desktop started second on a server's folder is not refused (it fails to bind the API port instead); a desktop change, out of M1.

**Upstream, measured 2026-11-02:** `upstream/main` is 520 commits past `dc623b59` (2.0.6). `git merge-tree` of `up/tars-cloud` with it: no conflict. `electron/main.ts` changed in 25 of them (+135 -83), none on a guarded line; `package.json` 8 (version, `mcp-telegram` dropped from the builds); `electron/constants/index.ts` 1; `electron/tsconfig.json`, the window, tray and desktop-lifecycle files, the workflows: untouched. To merge before any upstream PR.

**Files:**
- Create: `electron/server/main.ts`, `electron/server/cli.ts`, `electron/server/lock.ts`, `scripts/tars-server.service`, `scripts/server-install.sh`, `__tests__/fixtures/no-electron.cjs`
- Modify: `__tests__/electron/host/server-graph.test.ts` (adds `electron/server/main.ts` to `CORE_ROOTS`)
- Test: `__tests__/electron/server/serve.test.ts`, `__tests__/electron/server/lock.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - CLI `node electron/dist/server/cli.js <command>`: `serve [--dev]` (foreground, what systemd runs), `start --json` (the unit when installed, else `serve` detached, writing `server-started-by: desktop` beside its pid), `status --json` → `{ running: boolean; pid?: number; doorPort?: number; serverId: string; name: string; version: string }`. Every `--json` command writes exactly one JSON line on stdout; logs go to stderr and `DATA_DIR/logs/server.log`.
  - `claimDataFolder(): { ok: true; release(): void } | { ok: false; heldBy: 'desktop' | 'server'; pid?: number }`: refuses when a Tars answers `GET /api/health` on `API_PORT`, or a live pid holds `PRIVATE_DIR/server.lock`; a stale lock is taken over.
  - `scripts/tars-server.service`: `ExecStart=/usr/bin/env node %h/tars-server/electron/dist/server/cli.js serve`, `Restart=on-failure`, `WorkingDirectory=%h/tars-server`, no `User=` (a user unit).

- [ ] **Step 1: Write the failing tests.** Header: `serve` requiring `electron` (it runs under `node -r __tests__/fixtures/no-electron.cjs`, which throws on any load of `electron`); `refuses a data folder another Tars uses` (a fake health server on the API port: `serve` exits 1 naming it, writes nothing under `DATA_DIR`); a stale lock blocking; `status --json` printing more than one line or a log line on stdout; SIGTERM leaving a port bound or exiting non-zero after 10 s; `start` when already running starting a second one.
- [ ] **Step 2:** run `npx tsc -p electron/tsconfig.json && npx vitest run __tests__/electron/server`. Expected: FAIL.
- [ ] **Step 3:** implement `server/main.ts`: `installHeadlessElectron(createHeadlessElectron(...))` before any other require, then `claimDataFolder`, then `require('../main')` (Task 3); SIGTERM and SIGINT call `app.quit()`, so the before-quit shutdown steps run as on the desktop. The MCP bundles may be absent (a dev checkout): the server logs it once and runs on. Write the unit and `server-install.sh` (the steps OPERATIONS.md lists in Task 8, `set -eu`, no `sudo` inside: what needs root is printed for the person to run); neither is run against the server in M1.
- [ ] **Step 4:** PASS, then the graph test again with the new root. Expected: PASS.
- [ ] **Step 5:** commit `feat: run tars without a window, as a server`.

### Task 5: Client credentials (done)

**Status 2026-11-02:** `services/cloud/{types,clients,server-identity}.ts` and `server/clients-command.ts`, wired as `cli.js clients add|list|revoke`; `status --json` now carries `serverId` and `name`. As planned, plus an optional lifetime (`days`, 1 to 3650: `expiresAt`, refused once past) and `may(client, scope)`; functions take the file path (the CLI passes `PRIVATE_DIR/cloud-clients.json`). `watchClients(file, onRevoke, intervalMs)` polls the file (`fs.watchFile`) in place of an `onRevoke` global. Tests: `__tests__/electron/cloud/clients.test.ts` 20 (+ the 0600 case on POSIX) and `serve.test.ts` (the compiled CLI: input on stdin, one line out, the `serverId` `status` gives). Eight mutants, each killed: expiry ignored, any well-formed credential admitted, revoke not written, `may` granting all, the hash in a listing, format characters in a name, a corrupt file read as empty, `revoke` taking any id.

**Files:**
- Create: `electron/services/cloud/types.ts`, `electron/services/cloud/clients.ts`, `electron/services/cloud/server-identity.ts`
- Modify: `electron/server/cli.ts` (`clients add --json` reading `{ name, kind, scopes }` on stdin, `clients list --json`, `clients revoke <id>`)
- Test: `__tests__/electron/cloud/clients.test.ts`, `__tests__/electron/server/cli-clients.test.ts`

**Interfaces:**
- Produces:
  - `export type Scope = 'see' | 'drive' | 'create' | 'files'`; `export type ClientKind = 'desktop' | 'outside-agent'`
  - `export interface CloudClient { id: string /* c_<8 hex> */; name: string; kind: ClientKind; scopes: Scope[]; hash: string; createdAt: string; lastSeenAt?: string }`; `export type ClientView = Omit<CloudClient, 'hash'>`
  - `addClient(input: { name: string; kind: ClientKind; scopes: Scope[] }): { client: ClientView; credential: string }`, `listClients(): ClientView[]`, `revokeClient(id: string): boolean`, `admit(credential: string | undefined): CloudClient | null` (re-reads the file each call, fails closed), `onRevoke(listener: (id: string) => void): () => void` (fed by a watch on the file, so a revoke from the CLI reaches the running server), `MAX_CLIENTS = 32`
  - `serverIdentity(): { id: string /* 16 hex */; name: string }` (created once in `cloud-server.json`, name from the hostname)

- [ ] **Step 1: Write the failing tests.** Header: a credential stored in clear, or its hash or credential in `listClients` or `clients list`; a credential of another length throwing in the compare; a 33rd client; a name empty, over 60 characters, or carrying controls, newlines or format characters; an unknown or empty scope list; a revoked credential admitted; a corrupt or half-written file admitting anyone (writes are atomic, a bad file admits no one and says so on stderr); `clients add` writing anything on stdout but the one JSON line; `clients revoke` with an id not matching `^c_[0-9a-f]{8}$` reaching the file; a revoke from the CLI not reaching `onRevoke` within 2 s; the file's mode other than `0600` (POSIX; the ACL through `secret-file`'s own check on Windows).
- [ ] **Step 2:** FAIL. **Step 3:** implement with `crypto.randomBytes(32)`, `sha256`, `timingSafeEqual` over the hashes, `writeSecretFileSync`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: a tars server mints, lists and revokes its clients`.

### Task 6: The door: bind, admit, see

**Status 2026-11-02: split.** **6a done:** `services/cloud/door.ts` (`startDoor(deps): Promise<Door>`, `isLoopbackAddress`, `MAX_BODY`), `GET /cloud/v1/hello` and `GET /cloud/v1/fleet` (the fleet itself from `deps.fleet(client)`), the gates in this order: a caller address not loopback (403), not a route (404, before any credential), `Origin` (403), a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (403), `Content-Length` over 64 KB (413), the credential, `Authorization: Bearer` only (401), the route's scope (403, naming server and client). Tests: `__tests__/electron/cloud/door-admit.test.ts` 13, including a connection to this machine's own LAN address refused. Eight mutants, each killed: listening on every interface, any caller address, `Origin` let through, any `Host`, an unknown path answering 401 without a credential, no body cap, the scope unchecked, a credential without `Bearer`. **6b, first half done:** `fleet-share.ts` (the server's half of the fork's, retyped: named fields only, strings bounded, control **and format** characters dropped, which the fork kept; `SharedAgent.agentId` as planned; 8 tests, six mutants killed), `fleet-source.ts` (`fleetAnswer`: the agents and the projects they are in), `CLOUD_DOOR_PORT = API_PORT + 2` in `constants`, and the door started by `server/main.ts` right after `main.ts` loads (it reads the fleet at each request; a door that cannot open is logged and the agents keep running). `serve.test.ts` proves it on a real boot: `hello` gives the `serverId` the CLI minted under, the fleet answers a `see` client, the master API token (read from the server's own `PRIVATE_DIR/api-token`) is refused and appears in no answer. **6b, second half done (Task 6 complete):** `electron/core/agent-output.ts` (`onAgentOutput`, `emitAgentOutput`, a module of its own so it is tested without Electron; `attachAgentTerminal` calls `emitAgentOutput` right after its `agent:output` broadcast, the one line `agent-manager.ts` changes, and the desktop registers no listener); `fleetAnswer(client, server, agents, liveOf)` reads `cliRunning`, `cols` and `rows` from the terminal at each answer, never from the record; the door's `GET /cloud/v1/agents/:agentId/screen` (`{ screen, cliRunning, cols, rows }`, the terminal mirror's snapshot as `agent:get` replays it) and `GET .../stream` (server-sent events: `data:` chunks of that agent alone, `event: end` with a reason), both `see`, the agent looked up only after the credential and the scope, one 404 sentence naming no agent; `MAX_STREAMS_PER_CLIENT = 32` (429), a reader more than `MAX_BEHIND` (4 MB) behind destroyed, a revoke ending that client's streams within the clients file's poll (500 ms, `watchClients`), an expiry at the next re-check (15 s); `server/main.ts` gives the door the real terminals (`ptyProcesses`, `cliRunningIn`, `terminalSnapshot`, `onAgentOutput`). Tests: `door-see.test.ts` 8, `agent-output.test.ts` 3, `fleet-source.test.ts` 3; eleven mutants, each killed. The 124 test files that import `agent-manager.ts` fail exactly as at the local baseline (44 lines, none new).

**Files:**
- Create: `electron/services/cloud/door.ts`, `electron/services/cloud/fleet-share.ts`, `electron/services/cloud/fleet-source.ts`
- Modify: `electron/constants/index.ts` (`CLOUD_DOOR_PORT = API_PORT + 2`), `electron/core/agent-manager.ts` (`onAgentOutput`, fed where a terminal's data is broadcast as `agent:output`, `attachAgentTerminal` near line 1339), `electron/server/main.ts` (starts the door once the boot logs `App initialization complete`, closes it first at shutdown)
- Test: `__tests__/electron/cloud/door-admit.test.ts`, `__tests__/electron/cloud/door-see.test.ts`, `__tests__/electron/cloud/fleet-share.test.ts`, `__tests__/electron/core/agent-output-listeners.test.ts`

**Interfaces:**
- Consumes: Task 5's `admit`, `onRevoke`, `serverIdentity`; `agents`, `ptyProcesses`, `terminalSnapshot` (`core/terminal-mirror.ts:209`), `cliRunningIn` (`core/agent-pty.ts:300`), `withSessionTruth` (`services/agent-truth.ts:517`).
- Produces:
  - `export function onAgentOutput(listener: (agentId: string, chunk: string) => void): () => void` (a throwing listener is logged and kept from the others)
  - `export interface SharedAgent { agentId: string; name: string; character?: string; provider?: string; model?: string; status: string; currentTask?: string; branch?: string; projectName: string; projectPath: string; cliRunning: boolean; lastActivity?: string; stoppedBy?: string; stopReason?: string; cols?: number; rows?: number }`
  - `export interface CloudProject { name: string; path: string }`; `export interface FleetAnswer { v: 1; server: { id: string; name: string }; youMay: Scope[]; projects: CloudProject[]; agents: SharedAgent[] }`
  - `startDoor(deps: DoorDeps): Promise<{ port: number; close(): Promise<void> }>` with `DoorDeps { port: number; admit; onRevoke; identity(): { id: string; name: string; version: string }; fleet(client: CloudClient): FleetAnswer; screenOf(agentId: string): { screen: string; cliRunning: boolean; cols: number; rows: number } | null; onOutput: typeof onAgentOutput; drive?: (r: DriveRequest, c: DriveCaller) => Promise<DriveOutcome> }`
  - Routes: `GET /cloud/v1/hello` (no credential: `{ v: 1, serverId, name, version }`), `GET /cloud/v1/fleet`, `GET /cloud/v1/agents/:agentId/screen`, `GET /cloud/v1/agents/:agentId/stream` (SSE `data:` chunks, `event: end`), each needing `see`; `MAX_STREAMS_PER_CLIENT = 32`, `MAX_BODY = 65536`

- [ ] **Step 1: Write the failing tests.** Admit: listening on anything but `127.0.0.1`; a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` served (403: a page in a desktop's browser rebinding a name to the forward); a request with `Origin` served (403); an unknown path reading the credential (404 first); a body over 64 KB read (413 unread); the master API token, an agent's token or Tars's pass admitted; a credential in the query string admitted; `hello` carrying anything but its four fields. See (from the fork's §8 "What See shows"): a token, env, CLI path, worktree, session id, skills, permission mode or asker in a shared agent; an unbounded string; a fleet without `youMay`; a client without `see` reading the fleet; an unknown agent answering differently from a known one (one 404 sentence, naming no agent); a 33rd stream from one client; a reader 4 MB behind kept open; `revoke cuts that client's streams at once`.
- [ ] **Step 2:** FAIL. **Step 3:** port `fleet-share.ts` and the read half of `fleet-source.ts` from `origin/win/machines` (retyped), and the bridge server's admission order (path, then `Origin` and `Host`, then size, then credential) into `door.ts`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: a tars server's door, and what its clients may see`.

### Task 7: Drive: the executor, the sender line, the routes

**Status 2026-11-02: split.** **7a done (keys and size, which need no sender line):** `services/cloud/drive.ts` (`executeDrive(request, caller, target)`, `DriveTarget { hasAgent, typeKeys, resize }`, `MAX_KEYS = 4096`): an `outside-agent` caller never types or resizes (403, whatever its scopes); one 404 sentence naming no agent; keys 1 to 4,096 characters, 409 where no terminal runs; a size two whole numbers 1 to 1000, remembered even with no terminal as `agent:resize` does. The door's `POST /cloud/v1/agents/:agentId/keys` and `/size` (`drive`): refused before the body is read when the client lacks `drive`; the body counted to 64 KB, chunked or not (413); not JSON (400); then the client admitted again, and the same client (401 if revoked or changed meanwhile). `server/main.ts` drives the real terminals by the window's path (`writeHumanInput`, `rememberPanelSize`, the PTY's resize, `resizeTerminalMirror`). Tests: `drive.test.ts` 14, `door-drive.test.ts` 7; twelve mutants killed (two survived a first round and led to a test of the early refusal and to the same-client check). **7b done (Task 7 complete):** `executeDrive` is async and adds `start` (no first prompt; a failed launch says why, 409), `stop` (a reason of 1 to 200 characters that says something once controls and format characters are gone; filed under `<name> (machine)` or `<name> (outside agent)`) and `message` (1 to 8,000 characters that say something; 409 where no terminal runs or the CLI has ended); an outside agent may start, stop and message, never type or resize. Two sender kinds, not one: `{ kind: 'machine'; name }` (`Message from the machine "<name>": `) and `{ kind: 'outside-agent'; name }` (`Message from the outside agent "<name>": `), so Hermes is never presented as a machine; names go through `envelopeValue`, quoted on one line. Readers changed: `senderLine`, `chat-transcript.ts` (`CLIENT_ENVELOPE`: the transcript shows the client's name, not the user's own words), `task-ledger.ts` (`handOffFrom`; `TaskSource` gains `machine` and `outside-agent`), `kanban-routes.ts` and `chat-runners.ts` (the client's name, not Tars), `agent-instructions.md` and `super-agent-instructions.md` (each line hands work as Tars does, answers no question asked of the user, lifts no rule). Not changed, measured: `carry-over.ts` keeps any sender kind as it is, and `task-requests.ts` matches agent envelopes only. Door routes `POST .../start`, `/stop` (`{ reason }`), `/message` (`{ text }`), same gates as keys and size; `server/main.ts` starts by `launchAgent(id, '')`, stops by `stopAgent`, types by `writeProgrammaticInput` with the client's sender. Tests: `drive.test.ts` 23, `door-drive.test.ts` 8, `sender-line-client.test.ts` 4; twelve mutants killed. The 33 test files reading senders or these instructions fail exactly as at the local baseline (50 lines, none new).

**Found on the way:** `serve.test.ts` waited for `App initialization complete` alone, but the local API's listen is asynchronous (it retries), so a request could arrive first (ECONNREFUSED, 1 run in 3 here); it now waits for the API's own `Agent API server running on` line too, and the door case for `[cloud] door on`.

**Files:**
- Create: `electron/services/cloud/drive.ts`
- Modify: `electron/core/pty-manager.ts:447-473` (`MessageSender` gains `{ kind: 'machine'; name: string }`; `senderLine` returns `Message from the machine ${envelopeValue(name)}: `) and every reader of that union: `services/task-ledger.ts:877` (`handOffFrom`, `TaskSource` gains `machine`), `services/chat-runners.ts:366`, `services/api-routes/kanban-routes.ts:136`, `services/carry-over.ts:72`, `core/task-requests.ts:64-66`, `services/chat-transcript.ts:69` (`OTHER_ENVELOPE` matches the new line, or a machine's message reads as the user's own words), `resources/agent-instructions.md:55-57`, `resources/super-agent-instructions.md:90`; `electron/services/cloud/door.ts` (the five POST routes)
- Test: `__tests__/electron/core/sender-line-machine.test.ts` (a case per reader), `__tests__/electron/cloud/drive.test.ts`, `__tests__/electron/cloud/door-drive.test.ts`

**Interfaces:**
- Consumes: `launchAgent` (`core/agent-launch.ts:80`), `sessionStarting` (`:173`), `wakeAgent` (`core/agent-asleep.ts:137`), `stopAgent`, `noteRestartAfterStop` (`core/agent-stop.ts`), `writeProgrammaticInput` (`core/pty-manager.ts:1288`), `writeHumanInput` (`:686`), `resizeTerminalMirror` (`core/terminal-mirror.ts:179`), `rememberPanelSize` (`:520`), `broadcastToAllWindows`, `scheduleTick`.
- Produces:
  - `export type DriveRequest = { action: 'start'; agentId: string } | { action: 'stop'; agentId: string; reason: string } | { action: 'message'; agentId: string; text: string } | { action: 'keys'; agentId: string; data: string } | { action: 'size'; agentId: string; cols: number; rows: number }`
  - `export interface DriveCaller { name: string; kind: ClientKind }`; `export type DriveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; error: string }`
  - `executeDrive(request: DriveRequest, caller: DriveCaller): Promise<DriveOutcome>`; `MAX_DRIVE_TEXT = 8000`, `MAX_KEYS = 4096`
  - Routes: `POST /cloud/v1/agents/:agentId/{start,stop,message,keys,size}`, each needing `drive`

- [ ] **Step 1: Write the failing tests.** Executor: a start that types a first prompt; a stop without a reason, or a reason of controls only; a stop filed under anything but `<name> (machine)`; a message over 8,000 characters or of controls and format characters only; a message into a terminal whose CLI has ended; a paste end or a look-alike sender line typed raw; keys over 4,096 characters or with the CLI not running; a size outside whole numbers 1 to 1000; a size from a client echoing a resize back (the server's own pane, if any, is told and does not answer until its next click or key); `keys` or `size` from an `outside-agent` caller (403). Routes: a client without `drive` driving (403 "<server> lets <client> see only."); `drive` taken back between the head and the body still driving; a client revoked mid-request driving; a body over 64 KB read.
- [ ] **Step 2:** FAIL. **Step 3:** port the drive half of `origin/win/machines:electron/services/machines/fleet-source.ts` into `executeDrive`, which knows nothing of HTTP. It follows the window's IPC path (`agent:stop` at `ipc-handlers.ts:1079`, `agent:resize` at 1235), not the API's guards for agents (`resolveDriver`, `mayStop` in `agent-routes.ts:811-894`): a desktop client is the user at another keyboard, not an agent. A stop still needs its reason (`stopReasonOf`). The routes re-read the client after the body. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: drive a tars server's agents from a client`.

### Task 8: M1 proven: the server spec, docs, review

**Status 2026-11-02, part 1:** `__tests__/electron/server/server-agent.test.ts`: a compiled server under plain Node, its agent a real PTY on the recording fake claude, driven through the door by a minted desktop client: start (the fleet then says the CLI runs), the stream carries the CLI's answer to typed keys, a message reaches the CLI after `Message from the machine "Mac": `, a stop is filed under `Mac (machine)` with its reason, a revoke ends the stream and the next request is a 401. POSIX only (`describe.skipIf(win32)`): the server runs on Linux, and on Windows Tars does not start these stand-ins from a PTY (measured: an extensionless script is refused, a cmd-shim is read through and still never runs; the base's Windows E2E fails the same way on qwen and gemini), so the ubuntu CI job is its proof. Found by it and fixed: `launchAgent` throws a `LaunchError` for a CLI it cannot start, which reached the door as a 500 with no reason; the server's start now answers 409 with the launcher's sentence. Not done yet: the restart case (an agent running before a SIGTERM comes back after `serve` again).

**Part 2:** `SECURITY.md` §8 "A Tars server and its clients" (the door's gates, SSH access as the real authority, what a credential is and is not, scopes, what `see` shows and `drive` gives away, the outside agent's ceiling, one server per data folder) and `OPERATIONS.md` "A Tars server (headless)" (requirements, build, run, the user unit, ports, clients, files, update). Left before the security review: the restart case, the full gate (both `tsc`, `npm test` against the baseline, `lint`, `lint:design`, `check:names`, `check:dashes`, `e2e:guard`), and the Windows E2E comparison of 95d814a6.

**Files:**
- Create: `__tests__/electron/server/server-e2e.test.ts`
- Modify: `SECURITY.md` (new section "The Tars server and its clients": the door is loopback only and reached through SSH; SSH access is the real authority; what a credential is and is not; what `see` shows, terminals as they are, secrets a CLI echoes included; what `drive` gives away, a shell as the server's user; the outside-agent ceiling), `OPERATIONS.md` ("Run a Tars server": a non-root user, Node 22, `build-essential` and `python3`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, the builds, the user unit and `loginctl enable-linger`, each CLI's login on the server, `clients list|revoke`, backing up `DATA_DIR` and `PRIVATE_DIR`, updating), `SPECS.md`

- [ ] **Step 1: Write the failing spec.** In a sandbox HOME with the recording fake CLIs (`writeFakeClis` from `e2e/fake-clis.mjs`), one project and one stopped agent on the fake CLI, ports away from the running Tars: spawn `node -r __tests__/fixtures/no-electron.cjs electron/dist/server/cli.js serve`; `clients add` (desktop, `see` and `drive`); `hello` answers the `serverId` of `status --json`; the fleet lists the agent; start, and it reads running; the stream shows the fake CLI's marker; keys `hello` reach its recorded input; a message arrives after `Message from the machine "<name>": `; a size reaches its recorded `cols`; a stop with "done for today" files `<name> (machine)` and the reason; `agents come back after the server restarts` (SIGTERM, `serve` again, the started agent is running again and its new stream shows the marker); `clients revoke` ends the open stream and the next fleet is a 401. It records the server's RSS idle and with three fake agents running. Artefact: the asserted values as JSON, `server.log`, the reproducing command, in one run directory.
- [ ] **Step 2:** FAIL until Tasks 4 to 7 are in, then PASS locally. **Show it bites:** a mutant where the drive route skips the second read of the client lets a revoked client stop the agent; record the red run.
- [ ] **Step 3:** push `up/tars-cloud` to `origin`; the ubuntu CI job runs the spec: the first run of Tars's core on Linux. Expected: green; a Linux-only failure is fixed at its root in the core, under `electron/platform/` when it is a platform difference.
- [ ] **Step 4:** the docs above; the full gate; the security review until clean.
- [ ] **Step 5:** commit `docs: the tars server, its clients, and how to run one`; push to `origin` only. Report to Nicolas: M1's measurements (RSS) and decisions 1 and 2.

---

## M2: the desktop connects over SSH, sees and drives (outline)

- **Install on the server, with Nicolas's go** (decisions 1 and 2). First a Hostinger snapshot of the VPS, taken just before anything is installed, so the server can be put back as it was.
  - **Leading option, pending his final go at install time: the server Tars in a Docker container.** An image built from the fork's checkout (Node 22, `build-essential` and `python3` for `node-pty`, `git`, the CLIs Tars runs), a non-root user inside, a memory cap (`--memory 3g --memory-swap 3g`) so Hermes and n8n always keep room, its own volumes (`tars-home`: the HOME with `DATA_DIR`, `PRIVATE_DIR` and the CLIs' logins; `tars-projects`: the projects root), nothing mounted from Hermes's, n8n's or `ubuntu`'s folders, `--restart unless-stopped` in place of the systemd unit, and removable in one command (`docker rm -f tars-server && docker volume rm tars-home tars-projects`). It answers decision 1 by itself: the container is the separate user.
  - **The door and the SSH forward** (superseded: the door is now a Unix socket, see "Review of 6096a87d"). The door binds `127.0.0.1`, and a container's own loopback cannot be published with `-p`. Recommended: `--network host`, so the door binds the host's `127.0.0.1:31417` and nothing changes for the forward (`-L <local>:127.0.0.1:31417`) or the Global Constraints; the cap and the separate files still hold. The other way, `-p 127.0.0.1:31417:31417` with the door binding the container's interface, needs a container-only bind setting and lets other containers on the same Docker network reach the door (a credential still required): not taken unless host networking is refused.
  - **The SSH commands.** `status`, `start`, `clients add|list|revoke` run as `docker exec -i tars-server node electron/dist/server/cli.js <command>` over SSH (stdin still carries the JSON); "start if down" is `docker start tars-server`. The SSH user must be allowed to run `docker`, which is root on the host: true of `ubuntu` today if it runs Docker, and said in SECURITY.md.
  - **The CLIs' logins.** Done once inside the container by Nicolas in a terminal (`ssh -t <host> docker exec -it tars-server claude login`, the same for Codex and the others), kept in `tars-home` across image updates; the Claude Code he runs in tmux as `ubuntu` keeps its own login and settings, and Tars's hooks never reach it. API keys come with "Copy my provider settings to the server" (decision 3).
  - **Updates.** Rebuild the image from the fork, recreate the container on the same volumes.
  - Without Docker: `scripts/server-install.sh` replayed command by command, each announced; the user unit enabled.
  - Either way: `status --json` over SSH from the PC; memory measured beside Hermes, n8n and his tmux sessions.
- **Main process, new files under `electron/services/cloud-link/`:** `ssh.ts` (`sshArgv(host, purpose)`, the host check, `spawn` without a shell; the forward's options adapted from T3's `packages/ssh/src/tunnel.ts`, cited), `link.ts` (status, start if down, mint once, forward on a free `127.0.0.1` port, `hello` checks the `serverId` before the credential is sent, one retry owner with jittered backoff capped at 5 min, `one forward per server at most`, `a dropped link stops nothing on the server`, `a 401 reads as disconnected, not offline`), `client.ts` (fleet, screen, stream, drive through the forward), `remote-fleet.ts` (ported; ids `c:<serverId>:<agentId>`; `one fleet request in flight at most`, `reattaches a watched pane once after offline`); `electron/handlers/cloud-handlers.ts`; `preload.ts` and `electron.d.ts` (`window.electronAPI.cloud`) in one commit. The SSH layer's tests run a fake `ssh` that records its argv and proxies the forward; no test reaches a real host.
- **Settings > Cloud** (frames first): the host (`user@host` or an SSH alias), Connect, Disconnect, Forget, the status (connected, offline since, disconnected by the server, the SSH error in plain words: host key unknown, key refused, passphrase needs an agent), the server's clients with Revoke (over SSH, `clients list|revoke`), "Copy my provider settings to the server" (decision 3).
- **Renderer, ported from `win/machines`:** the server's agents merged into Dashboard and Agents with a badge (the `--machine-ink` token), the filter ("This Tars", then the server), the offline line, the live pane (Drive panes take the viewing pane's size, See panes scale the remote size to fit), start, stop with a reason (`MachineStopReason`), message, typing through `keyQueue` (`keys keep their order and stop at the first failure`); cloud projects listed with the badge.
- **E2E** `e2e/cloud-see-drive.spec.ts`: a sandboxed desktop and a headless server process started by the spec, linked by a direct route the test sets (read only when not packaged), so CI needs no SSH; the SSH path is proven by its units and the real test.
- **Real test, server + Mac + PC:** connect from both; see and drive from both; the server restarts; the Wi-Fi drops on the Mac; one client revoked; `ss -ltnp` on the server shows the door on `127.0.0.1` only; nothing new on the tailnet.

## M3: create a cloud project or agent (outline)

- Server: `POST /cloud/v1/projects` (`create`): `{ name, from: { kind: 'empty' } | { kind: 'git'; url } }` under a projects root (default `~/tars-projects`, set in the server's settings), the name through the same guards as worktree paths, `git clone` by `execFile` with the server's own git credentials; `POST /cloud/v1/agents` (`create`): the fields the window's New agent form sends, through the same creation path as `agent:create` (the spawn rule: `spawnAgentSession` and `initAgentPty`, no third way).
- Desktop: New project asks Local or Cloud (frame first); New agent in a cloud project goes to the server; the fleet's `projects` feeds the Projects list.
- Tests: failures first for names, URLs (no `file:`, `ext::` or option-looking URLs), a client without `create`; one E2E creating a cloud project and an agent that runs on the server's fake CLI.

## M4: move a project to the cloud (outline)

- The button on a local project (frame first); its dialog lists the agents, the size, the folders left out (decision 5), and asks once.
- Steps, each undoable until the last: stop the project's agents (reason "moved to the cloud"); stream the folder as a tar (the system `tar`: bsdtar on macOS and Windows) into `ssh -- <host> tars-server import receive --json` (staging under `<projects root>/.incoming/<id>`; extraction refuses absolute paths, `..`, and links leaving the folder; no owner kept); on the server, restore the exec bits git records (`git ls-files -s`, mode `100755`; a tar from Windows has none) and `git worktree repair` for worktrees inside the project; `POST /cloud/v1/imports/:id/commit` (`create` and `files`) moves it into place and recreates each agent with the same provider, model, effort, permission mode, skills, role, name and character, its project path rewritten; rename the local folder `<name> (moved to cloud YYYY-MM-DD)` and remove the local agents only once the server confirms.
- **The handoff excerpt** (T3's portable handoff, `docs/user/portable-handoffs.md`): per agent, a budgeted selection of its saved conversation, not a summary: the first request, then the most recent requests and answers, roles and order kept, 16,000 bytes by default (one byte counted as one token), written to `DATA_DIR/handoffs/<agentId>.md` on the server; the agent's first message points to it. Claude Code transcripts first; a provider whose transcript Tars does not read gets a line saying no excerpt was carried.
- Failure modes pinned first: the link drops mid-copy (staging discarded, nothing local changed); the server's disk fills; a name taken on the server; a worktree outside the project folder (listed, not moved); a project whose agents will not stop.

## Review of 6096a87d (2026-11-02): the door on a Unix socket

The fresh security review found one blocking hole: the door on `127.0.0.1:31417` could be bound by any local process, another account or a host-network container while the server was down, which would answer `/hello` with the real server id and collect desktops' credentials. Fixed: the door is `~/.tars-private/door.sock` (0600, folder 0700, owned, never a link; a link or a file at the path refused and left; another door refused; a stale socket removed), a door failure is fatal (exit 1), `status` names the socket. Also fixed from its nits: 64 streams in all and 1 MB behind per stream, 128 connections, 10 s headers, 30 s requests; the 15 s re-check also re-checks `see`; Host is `localhost` or `127.0.0.1` on any port (the forward's local port), still refusing a rebound name; the data-folder claim is exclusive (`O_EXCL`) and a pid that `/proc` shows running something else is a server that died; a detached `start` leaves `SSH_*` behind and logs under `~/.tars-private`; each mint is logged by the running server and `clients list` says where it came from. Consequences for later milestones:

- **M2:** the desktop forwards to the socket: `ssh -N -L 127.0.0.1:<free local port>:<remote home>/.tars-private/door.sock <host>` (OpenSSH forwards to a remote Unix socket since 6.7). The remote home comes from `status --json` (it names the socket). The desktop started second on a server's data folder (not refused today: it fails to take the API port) is handled in M2, where the desktop learns about servers.
- **Docker (M2 install):** the socket lives in the `tars-home` volume (`/home/tars/.tars-private/door.sock` inside the container); with `--network host` nothing changes for the API, and the SSH forward targets the volume's path on the host (`/var/lib/docker/volumes/tars-home/_data/.tars-private/door.sock`, readable by root only), so the SSH user must be the one Docker maps to, or the forward goes through `docker exec` instead: decided at install.
- **M5 (Hermes):** Hermes runs as another Linux user (`hermes`) and cannot open a 0700 socket. Recommended: Hermes reaches the server as a desktop does, through SSH to the server's user with a key of its own restricted in `authorized_keys` to `permitopen`-style forwarding of that one socket (`restrict,port-forwarding,permitlisten="none",permitopen="none"` plus `ForceCommand` refusing a shell), then its outside-agent credential; nothing opens the socket to another account. The alternative, a second socket with a group shared with `hermes`, is refused: it reopens the door to any process of that group.

## M5: Hermes as an outside agent (outline)

- `tars-server clients add` with `kind: 'outside-agent'`, name `Hermes`, scopes `see`, `drive` and `create`, and its ceiling: no keys, no size (Task 7 already refuses them), no `files`, and agents it creates capped at a permission mode Nicolas picks.
- Hermes reaches the door through its own restricted SSH key and forward (see the review section above), never a shared socket; its credential lives in Hermes's own secret store. A small Hermes tool or skill (in Hermes's configuration, not in Tars) lists, starts, stops, messages and creates, and reports on Telegram as Hermes already does.
- In Tars: its messages read `Message from Hermes`, its stops `Hermes`, its agents "created by Hermes"; Settings > Cloud lists it with its last request.

---

## Self-review notes

- Spec coverage: decision 1 (M2 to M3), 2 (M4), 3 (Tasks 1 to 4, 8), 4 (M2, Tasks 5 and 6 for the credential and the door), 5 (Task 5 scopes and kinds, Task 7 ceiling, M5), 6 (Global Constraints Git, PR split, real test in M2).
- Assumptions: the server runs Node 22 and has a compiler; Nicolas's key works with `BatchMode=yes` (an agent or no passphrase) and the server's host key is already known to his machines (he SSHes there today); the projects root is on the server's own disk.
