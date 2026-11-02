# Tars cloud: a headless Tars server, reached over SSH. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nicolas's cloud projects live on his Linux server, where a Tars without a window keeps their agents, terminals and conversations running 24/7, and every desktop Tars he opens (Mac, PC) shows them beside its local projects, sees and drives them, creates new ones there, and moves a local project there on one click; Hermes, on the same server, acts on them as an outside agent with its own credential.

**Architecture:** the main process's core reaches Electron through one `Host` interface, with an Electron implementation (the desktop, unchanged) and a headless one (plain Node 22, no display), so `tars-server serve` runs the same agent manager, PTYs, hooks and local API as a systemd user service. The server adds a *door*: a second `node:http` listener bound to `127.0.0.1` only, admitting scoped client credentials minted on the server. A desktop reaches it with Nicolas's own SSH key: it starts the server if it is down, mints its credential over the SSH session, and forwards a local loopback port to the door; nothing new listens on any network, and no master token travels.

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

**The seam.** Measured on `upstream/main` (dc623b59): 46 of 301 non-test files under `electron/` import `electron`; walking value imports from the core (`api-server`, `agent-manager`, `pty-manager`, `telegram-bot`, `mcp-orchestrator`, `hooks-manager`) reaches 228 modules and 15 of those 46. Twelve are core and go through the host: `core/agent-manager.ts`, `core/pty-manager.ts` (`app.once`, `app.exit`), `services/api-server.ts`, `services/api-routes/{agent-routes,types}.ts`, `services/mcp-orchestrator.ts` (`app.isPackaged`, `app.getAppPath`, three `ipcMain.handle`), `services/state-mod.ts` (`app.getPath('userData')`), `services/telegram-bot.ts`, `utils/{broadcast,hooks-path,index,mcp-node}.ts`. Three are reached by one edge each and are cut, not wrapped: `handlers/chat-handlers.ts` (through `task-routes.ts`'s `liveChatStore`), `core/window-manager.ts` and `core/edit-context-menu.ts` (through `discord-bot.ts` and `slack-bot.ts`'s `getMainWindow`). The other 31 (window, tray, menus, dialogs, the 22 IPC handler files, the updater, `secret-handoff.ts`) stay desktop-only and untouched. The core already copes with `mainWindow === null` (a macOS Tars runs with every window closed), so the headless host is "a desktop whose window never opens", minus the `electron` module.

| Host member | Desktop (`ElectronHost`) | Headless (`HeadlessHost`) |
|---|---|---|
| `mainWindow()` | the window getter `main.ts` already has | always `null` |
| `broadcast(channel, ...args)` | `BrowserWindow.getAllWindows()` and `webContents.send`, as `utils/broadcast.ts` does | an in-process event bus the door can subscribe to |
| `appPath()`, `resourcesPath()`, `unpacked(p)` | `app.getAppPath()`, `process.resourcesPath`, `app.asar` to `app.asar.unpacked` | the install root (where `hooks/`, `skills/`, `mcp-*/dist` live) for both; `unpacked` is the identity |
| `userDataPath()` | `app.getPath('userData')` | `$XDG_STATE_HOME/tars-server` when absolute, else `~/.local/state/tars-server` |
| `isPackaged()` | `app.isPackaged` | `true` unless started with `--dev`, so the overrides a packaged Tars refuses stay refused on a server |
| `version()`, `name()` | `app.getVersion()`, `app.getName()` | `package.json` at the install root, `tars-server` |
| `notify(note)` | `new Notification(...)` where supported | a log line and an event on the bus (Telegram and Hermes already reach the phone) |
| `once('before-quit' or 'will-quit')`, `quit()`, `exit(code)` | `app.once`, `app.quit`, `app.exit` | SIGTERM and SIGINT run the same shutdown steps, then `process.exit` |

Nothing in the headless host opens a dialog, a tray or a URL: none of the 15 reached files uses `dialog`, `shell`, `Menu` or `clipboard`, and Task 2's graph test keeps it that way.

**Native modules.** `node-pty` 1.1.0 is an N-API addon: the same binary loads in Node and Electron (prebuilds for darwin and win32; on Linux it compiles at `npm ci`, so the server needs `build-essential` and `python3`). `better-sqlite3` 13.0.3 is installed for Node by `npm ci` (measured: both load under plain Node 24 from this worktree) and rebuilt for Electron only by `electron-builder` at packaging. The server installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, then `tsc -p electron/tsconfig.json` and the `mcp-*` builds, and runs `node electron/dist/server/cli.js serve`. No rebuild step is added for the desktop.

**The connection (M2), adapted from T3 Code's Desktop-managed SSH.** On Connect, the desktop's main process runs, each as one `ssh -o BatchMode=yes -- <host> <fixed command>`:
1. `tars-server status --json` → `{ running, doorPort, serverId, name, version }`; if not running, `tars-server start --json` (the systemd unit, or a detached `serve` marked as started by a desktop) and `status` again.
2. Once per server, `tars-server clients add --json`, with `{ name, kind: 'desktop', scopes }` on stdin → `{ id, credential, serverId }`, kept in `cloud-link.json`. Reconnecting reuses it. A 401 later is "Disconnected by <server>": Reconnect mints again only on the user's click.
3. The forward: `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -n -N -L 127.0.0.1:<local>:127.0.0.1:<doorPort> -- <host>` (T3's `startSshTunnel` options).
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

1. `refactor: the main process reaches electron through one host` (Tasks 1 to 3): no behaviour change. The one Noah must agree with first: it touches 15 core files and `main.ts`. Recommended: an issue describing it once M1 is proven, before M2's UI, on Nicolas's go.
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

1. **Which user runs the server** (before M2's install). Recommended: a dedicated non-root user `tars`, his key added to it, a systemd user unit with `loginctl enable-linger tars`. Agents with full permissions then cannot read Hermes's or n8n's files, and Tars's hooks do not land in the `~/.claude/settings.json` of the Claude Code he runs in tmux as `ubuntu`. The host becomes `tars@100.101.245.29`.
2. **When the server may be touched.** Recommended: one install session after M1 is green on CI, each command announced first (user, Node 22, `build-essential`, the unit, `claude` login for that user), then the memory measured beside Hermes, n8n and his tmux sessions.
3. **The server's settings and provider keys.** The server has no window to set them. Recommended: on first connect, an explicit "Copy my provider settings to the server" (keys over SSH only, never the master token, never automatic); each CLI's own login done once on the server. Telegram, Slack and Discord bots run in one place only (two pollers on one bot token fight): the server, once it is live.
4. **The phone.** The SSH choice drops the browser and phone client of `TARS-CLOUD.local.md` (2026-11-01). Recommended: Hermes on Telegram is the phone path for now (M5); a web door can come later on the same server and credentials, additive.
5. **What Move to cloud copies** (before M4). Recommended: everything, uncommitted work and `.env` included, except dependency folders built for this machine (`node_modules` and the like), listed in the dialog and editable; the local folder renamed `<name> (moved to cloud YYYY-MM-DD)`.
6. **Telling Noah.** Recommended: the issue for PR 1 once M1 is proven, on his go.

---

## File Structure (M1)

| File | Responsibility |
|---|---|
| `electron/host/types.ts` (new) | `Host`, `HostEvents` |
| `electron/host/index.ts` (new) | `setHost`, `host` |
| `electron/host/asar.ts` (new) | `unpackedPathOf`, today duplicated in `utils/index.ts:17-19` and `utils/hooks-path.ts:16-19` |
| `electron/host/electron-host.ts` (new) | `createElectronHost` |
| `electron/host/headless-host.ts` (new) | `createHeadlessHost`, the event bus |
| the 12 core files listed above | `electron` values replaced by `host()` calls; `import type` kept |
| `electron/services/live-chat-store.ts` (new) | `liveChatStore`, moved out of `handlers/chat-handlers.ts` |
| `electron/handlers/orchestrator-handlers.ts` (new) | the three `orchestrator:*` IPC handlers moved out of `services/mcp-orchestrator.ts` |
| `electron/services/discord-bot.ts`, `slack-bot.ts` | `host().mainWindow()` instead of `window-manager`'s `getMainWindow` |
| `electron/core/start-core.ts` (new) | `startCore`: what keeps agents alive and reachable without a window, in `main.ts`'s order |
| `electron/main.ts` | `setHost(createElectronHost(...))` first; calls `startCore`; registers `orchestrator-handlers` |
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

### Task 1: The host seam

**Files:**
- Create: `electron/host/types.ts`, `electron/host/index.ts`, `electron/host/asar.ts`, `electron/host/electron-host.ts`, `electron/host/headless-host.ts`
- Test: `__tests__/electron/host/host.test.ts`, `__tests__/electron/host/headless-host.test.ts`

**Interfaces:**
- Produces:
  - `export interface Host { readonly kind: 'desktop' | 'headless'; mainWindow(): BrowserWindow | null; broadcast(channel: string, ...args: unknown[]): void; appPath(): string; resourcesPath(): string; unpacked(p: string): string; userDataPath(): string; isPackaged(): boolean; version(): string; name(): string; notify(note: { title: string; body: string }): void; once(event: 'before-quit' | 'will-quit', listener: () => void): void; quit(): void; exit(code: number): void }` (`BrowserWindow` by `import type` only)
  - `export interface HostEvents { on(channel: string, listener: (...args: unknown[]) => void): () => void }`
  - `setHost(h: Host): void`, `host(): Host` (throws `Tars host not set: main.ts or server/main.ts calls setHost() first` when unset)
  - `unpackedPathOf(p: string): string`
  - `createElectronHost(getMainWindow: () => BrowserWindow | null): Host`
  - `createHeadlessHost(opts: { root: string; dev: boolean; log: (line: string) => void }): Host & { events: HostEvents; emitQuit(): Promise<void> }`

- [ ] **Step 1: Write the failing tests.** Header, the ways it fails: `host()` before `setHost` returning anything; a headless `mainWindow()` other than `null`; a broadcast that misses a subscriber, or stops at a subscriber that throws; `unpackedPathOf` touching a path without `app.asar`, or missing `app.asar` inside a longer path; a relative `XDG_STATE_HOME` used (the XDG spec makes it invalid); `isPackaged()` false on a headless host started without `--dev`; `version()` read from anywhere but the root's `package.json`; `notify` on a headless host throwing or writing nothing; `once('before-quit')` listeners not run, or run twice, by `emitQuit`.
- [ ] **Step 2:** run `npx vitest run __tests__/electron/host`. Expected: FAIL (modules missing).
- [ ] **Step 3:** implement. `ElectronHost` delegates each member to the exact call the core makes today (see the table above); it is the only file under `electron/host/` that imports `electron` by value.
- [ ] **Step 4:** run it again. Expected: PASS.
- [ ] **Step 5:** commit `refactor: a host interface for the main process, desktop and headless`.

### Task 2: The core reaches no Electron

**Files:**
- Create: `__tests__/electron/host/server-graph.test.ts`, `electron/services/live-chat-store.ts`, `electron/handlers/orchestrator-handlers.ts`
- Modify: the 12 core files (wiring: `host().<member>()` where they used `app`, `BrowserWindow`, `Notification`; `utils/broadcast.ts` becomes `host().broadcast`), `electron/services/api-routes/task-routes.ts` and `electron/handlers/chat-handlers.ts` (import `liveChatStore` from its new module), `electron/services/discord-bot.ts`, `electron/services/slack-bot.ts`, `electron/services/mcp-orchestrator.ts` (its `ipcMain.handle` calls move out), `electron/main.ts` (`setHost(createElectronHost(getMainWindow))` before the first line that can reach the core; `registerOrchestratorHandlers()` where the handlers were registered)

**Interfaces:**
- Consumes: Task 1.
- Produces: `CORE_ROOTS` in the test (the six roots measured above; Task 4 adds `electron/server/main.ts`); `registerOrchestratorHandlers(): void`.

- [ ] **Step 1: Write the failing tests.** `server-graph.test.ts` walks value imports (not `import type`) from `CORE_ROOTS` through relative specifiers and fails on any `electron` import, printing the chain that reaches it. A second case imports every core module with no host set and expects no throw: no `host()` call at module load. Header: a value import of `electron` anywhere in the core's graph; a `host()` call at module scope; a dynamic `import('electron')` or `require('electron')` missed by the walk.
- [ ] **Step 2:** run it. Expected: FAIL listing the 15 files.
- [ ] **Step 3:** route the 12 files through the host, cut the three edges, move the orchestrator handlers. No other change in those files: same calls, same order, same messages.
- [ ] **Step 4:** run it. Expected: PASS. **Show it bites:** put `import { app } from 'electron'` back in `utils/hooks-path.ts`; the test turns red naming the chain; record it in the commit body.
- [ ] **Step 5: The desktop is unchanged.** Both `tsc`, `npm test`, `npm run lint`, then `npm run e2e:auto` (it runs the whole suite for any `electron/` change). Expected: every surface keeps its reference screenshot, zero page errors. Then a dev run of the desktop: agents start, the tray, a notification, quit and relaunch with restart recovery.
- [ ] **Step 6:** commit `refactor: the core reaches electron only through the host`.

### Task 3: `startCore`, out of `main.ts`

**Files:**
- Create: `electron/core/start-core.ts`
- Modify: `electron/main.ts` (the `app.whenReady` body from line 539: the core's calls move into `startCore`, in the same order; the desktop's stay)
- Test: `__tests__/electron/core/start-core.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `export interface CoreContext { settings(): AppSettings; saveSettings(next: AppSettings): void; onStatusChange(agent: AgentStatus, status: string): void; previousRun: PreviousRun }`, `export interface CoreHandle { stop(): Promise<void> }`, `startCore(ctx: CoreContext): Promise<CoreHandle>` (a second call throws).

Read `main.ts` 190 to 1107 first. The rule: **core** is whatever keeps agents alive and reachable without a window (known so far: `loadAgents`, `startAgentAutosave`, `configureStatusHooks`, the MCP setup, `initVaultDb`, `startHermesRelay`, `startRelayRouting`, `startHermesSessionWatch`, `initTelegramBot`, `initSlackBot`, `startDiscordBot`, `initApiServer` with the OpenAI bridge, `startRestartRecovery`, `startAgentWatch`, `startTaskWatch`, the stall, sleep, Codex and Pi session watches, `startCliUpdates`, `startErrorTriage`, `startTmpRetention`); **desktop** is whatever draws, asks the person at the screen, or updates the app (`setupProtocolHandler`, `createWindow`, `initTray`, `registerIpcHandlers` and every `register*Handlers`, `startHealthMonitor`, `installDesktopShell`, `initAutoUpdater`, the data-folder notice, `startOverseerWatch`). A call that fits neither is listed in the commit body with where it went and why. `CoreHandle.stop` feeds `runShutdownSteps`.

- [ ] **Step 1: Write the failing tests.** Header: `startCore` twice; `stop()` leaving the API port bound (a second `startCore` in the same process cannot listen); `startCore` with a headless host touching the window. The test runs `startCore` under a headless host in the vitest sandbox HOME on an API port of its own.
- [ ] **Step 2:** FAIL. **Step 3:** move the calls, keeping their order. **Step 4:** PASS.
- [ ] **Step 5: The desktop is unchanged:** as Task 2 Step 5, full suite.
- [ ] **Step 6:** commit `refactor: the core starts from one function the desktop calls`.

### Task 4: `tars-server`: the entry, its CLI, its lock

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
- [ ] **Step 3:** implement `server/main.ts`: `setHost(createHeadlessHost(...))`, `claimDataFolder`, `startCore`, signals to the shutdown steps. The MCP bundles may be absent (a dev checkout): the server logs it once and runs on. Write the unit and `server-install.sh` (the steps OPERATIONS.md lists in Task 8, `set -eu`, no `sudo` inside: what needs root is printed for the person to run); neither is run against the server in M1.
- [ ] **Step 4:** PASS, then the graph test again with the new root. Expected: PASS.
- [ ] **Step 5:** commit `feat: run tars without a window, as a server`.

### Task 5: Client credentials

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

**Files:**
- Create: `electron/services/cloud/door.ts`, `electron/services/cloud/fleet-share.ts`, `electron/services/cloud/fleet-source.ts`
- Modify: `electron/constants/index.ts` (`CLOUD_DOOR_PORT = API_PORT + 2`), `electron/core/agent-manager.ts` (`onAgentOutput`, fed where a terminal's data is broadcast as `agent:output`, `attachAgentTerminal` near line 1339), `electron/server/main.ts` (starts the door after `startCore`, closes it first at shutdown)
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

**Files:**
- Create: `electron/services/cloud/drive.ts`
- Modify: `electron/core/pty-manager.ts:447-473` (`MessageSender` gains `{ kind: 'machine'; name: string }`; `senderLine` returns `Message from the machine ${envelopeValue(name)}: `) and every reader of that union: `services/task-ledger.ts:877` (`handOffFrom`, `TaskSource` gains `machine`), `services/chat-runners.ts:366`, `services/api-routes/kanban-routes.ts:136`, `services/carry-over.ts:72`, `core/task-requests.ts:64-66`, `services/chat-transcript.ts:69` (`OTHER_ENVELOPE` matches the new line, or a machine's message reads as the user's own words), `resources/agent-instructions.md:55-57`, `resources/super-agent-instructions.md:90`; `electron/services/cloud/door.ts` (the five POST routes)
- Test: `__tests__/electron/core/sender-line-machine.test.ts` (a case per reader), `__tests__/electron/cloud/drive.test.ts`, `__tests__/electron/cloud/door-drive.test.ts`

**Interfaces:**
- Consumes: `launchAgent` (`core/agent-launch.ts:80`), `sessionStarting` (`:173`), `wakeAgent` (`core/agent-asleep.ts:137`), `stopAgent`, `noteRestartAfterStop` (`core/agent-stop.ts`), `writeProgrammaticInput` (`core/pty-manager.ts:1288`), `writeHumanInput` (`:686`), `resizeTerminalMirror` (`core/terminal-mirror.ts:179`), `rememberPanelSize` (`:520`), `host().broadcast`, `scheduleTick`.
- Produces:
  - `export type DriveRequest = { action: 'start'; agentId: string } | { action: 'stop'; agentId: string; reason: string } | { action: 'message'; agentId: string; text: string } | { action: 'keys'; agentId: string; data: string } | { action: 'size'; agentId: string; cols: number; rows: number }`
  - `export interface DriveCaller { name: string; kind: ClientKind }`; `export type DriveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; error: string }`
  - `executeDrive(request: DriveRequest, caller: DriveCaller): Promise<DriveOutcome>`; `MAX_DRIVE_TEXT = 8000`, `MAX_KEYS = 4096`
  - Routes: `POST /cloud/v1/agents/:agentId/{start,stop,message,keys,size}`, each needing `drive`

- [ ] **Step 1: Write the failing tests.** Executor: a start that types a first prompt; a stop without a reason, or a reason of controls only; a stop filed under anything but `<name> (machine)`; a message over 8,000 characters or of controls and format characters only; a message into a terminal whose CLI has ended; a paste end or a look-alike sender line typed raw; keys over 4,096 characters or with the CLI not running; a size outside whole numbers 1 to 1000; a size from a client echoing a resize back (the server's own pane, if any, is told and does not answer until its next click or key); `keys` or `size` from an `outside-agent` caller (403). Routes: a client without `drive` driving (403 "<server> lets <client> see only."); `drive` taken back between the head and the body still driving; a client revoked mid-request driving; a body over 64 KB read.
- [ ] **Step 2:** FAIL. **Step 3:** port the drive half of `origin/win/machines:electron/services/machines/fleet-source.ts` into `executeDrive`, which knows nothing of HTTP. It follows the window's IPC path (`agent:stop` at `ipc-handlers.ts:1079`, `agent:resize` at 1235), not the API's guards for agents (`resolveDriver`, `mayStop` in `agent-routes.ts:811-894`): a desktop client is the user at another keyboard, not an agent. A stop still needs its reason (`stopReasonOf`). The routes re-read the client after the body. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: drive a tars server's agents from a client`.

### Task 8: M1 proven: the server spec, docs, review

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

- **Install on the server, with Nicolas's go** (decisions 1 and 2): `scripts/server-install.sh` replayed command by command, each announced; the unit enabled; `status --json` over SSH from the PC; memory measured beside Hermes, n8n and his tmux sessions.
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

## M5: Hermes as an outside agent (outline)

- `tars-server clients add` with `kind: 'outside-agent'`, name `Hermes`, scopes `see`, `drive` and `create`, and its ceiling: no keys, no size (Task 7 already refuses them), no `files`, and agents it creates capped at a permission mode Nicolas picks.
- Hermes calls `127.0.0.1:31417` on the server itself, no SSH; its credential lives in Hermes's own secret store. A small Hermes tool or skill (in Hermes's configuration, not in Tars) lists, starts, stops, messages and creates, and reports on Telegram as Hermes already does.
- In Tars: its messages read `Message from Hermes`, its stops `Hermes`, its agents "created by Hermes"; Settings > Cloud lists it with its last request.

---

## Self-review notes

- Spec coverage: decision 1 (M2 to M3), 2 (M4), 3 (Tasks 1 to 4, 8), 4 (M2, Tasks 5 and 6 for the credential and the door), 5 (Task 5 scopes and kinds, Task 7 ceiling, M5), 6 (Global Constraints Git, PR split, real test in M2).
- Assumptions: the server runs Node 22 and has a compiler; Nicolas's key works with `BatchMode=yes` (an agent or no passphrase) and the server's host key is already known to his machines (he SSHes there today); the projects root is on the server's own disk.
