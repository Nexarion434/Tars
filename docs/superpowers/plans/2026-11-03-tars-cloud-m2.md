# Tars cloud M2: the desktop connects over SSH, sees and drives. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a desktop Tars (Mac, PC) with a server configured in Settings > Cloud reaches the Tars server over Nicolas's own SSH key, starts it if it is down, holds a scoped credential minted there, and shows the server's agents in Dashboard and Agents beside its own: live terminal, typing, size, start, stop with a reason, message.

**Architecture:** new main-process files under `electron/services/cloud-link/` run the system `ssh` with argv arrays: one short `ssh` per server command (`status`, `start`, `clients add|list|revoke`), and one long `ssh -N -L` forward per connected server, from a local end the desktop owns to the server's door socket. An HTTP client speaks the door's `/cloud/v1` routes through that forward; the remote fleet poller (ported from `win/machines`) turns them into the window's remote agents. The window reaches all of it through `window.electronAPI.cloud`; no credential, host key or socket path is ever sent to it.

**Tech Stack:** as M1 (`docs/superpowers/plans/2026-11-02-tars-cloud.md`): Node 22, Electron 44 main process (CommonJS, `tsc -p electron/tsconfig.json`), `node:http` client with `socketPath` or a loopback port, the system OpenSSH client, Next.js 16 renderer, xterm 5, vitest, Playwright, the `pen` CLI.

**Spec:** the M1 plan's Decisions 4 and 5, its Global Constraints (all of them apply here), "The connection (M2)", the M2 outline, and "Review of 6096a87d" (the desktop's local end of the forward); the server as it really runs since the trial of 2026-11-02 (`C:\Users\nicol\.tars\project-files\tars-b624a5a880\reports\2026-11-02-tars-server-trial.md`): container `tars-server`, commands through `sudo docker exec -i tars-server node electron/dist/server/cli.js ...`, the door socket on the host at `/home/ubuntu/tars-cloud/home/.tars-private/door.sock` while `status` names the container's path `/home/tars/.tars-private/door.sock`. Prior art, read with `git show origin/win/machines:<path>` and retyped, never merged: `electron/services/machines/{remote-fleet,client,status}.ts`, `electron/handlers/machines-handlers.ts`, `src/lib/machines.ts`, `src/hooks/{useRemoteAgents,useRemoteDrive}.ts`, `src/components/{ui/MachineBadge,MachineStopReason,TerminalsView/components/RemoteDriveBar,Settings/MachinesSection}.tsx` and their tests. T3 Code (MIT, © 2026 T3 Tools Inc.): `packages/ssh/src/tunnel.ts` (the forward's options), `docs/internals/connection-runtime.md` (one retry owner, jittered backoff capped at 5 min), cited in the files that adapt them.

## Global Constraints (M2's own, on top of M1's)

- **How a server is run is part of its profile.** `ServerRunner` is `{ kind: 'command'; argv: string[] }` (a bare install: `['node', '<root>/electron/dist/server/cli.js']`) or `{ kind: 'docker'; container: string; sudo: boolean }` (today's server: `sudo -n docker exec -i tars-server node electron/dist/server/cli.js`). "Start if down" is `<argv> start --json` for `command` and `[sudo -n] docker start <container>` for `docker`. A `docker` profile also names `doorSocket`, the socket's path on the SSH host (the container's `status` names its own path, which the host does not have).
- **The remote command line is words, never a shell string built from input.** `ssh` hands its remote command to the remote shell as one string, so every word the desktop sends must parse back as itself: each word matches `^[A-Za-z0-9_@%+=:,./-]+$`, and a word that comes from the user (container, program, path) does not start with `-`. Anything else is refused before `ssh` runs. JSON input travels on stdin (`clients add`), and the only id on a command line (`clients revoke`) must match the server's `^c_[0-9a-f]{8}$`.
- **`sudo -n`, never a prompt:** a `sudo` that wants a password fails at once and says so (`BatchMode=yes` is the same rule for `ssh`).
- **The desktop's local end of the forward:** a Unix socket in `PRIVATE_DIR/cloud/` (0700) on macOS and Linux; on Windows a `127.0.0.1` port, chosen free, the credential sent only once `ssh` holds the port (`-v` reports `Local connections to 127.0.0.1:<port> forwarded`) and `hello` answers the expected `serverId` through it. The choice lives in `electron/platform/` (no `if (win32)` elsewhere). Accepted residual, said in SECURITY.md: another account on the same Windows PC racing that port; a process of the same account can read `cloud-link.json` anyway.
- **One forward per server at most, one retry owner, the server never stopped.** Disconnect, Forget, quit and crash end the local `ssh` only.
- **Off by default:** with no server in `cloud-link.json`, no `ssh` is ever spawned and no timer runs (a unit pins it).

## Review Focus

1. **The SSH user's shell prints on login** (a `.bashrc` banner, `motd`): a command's stdout is read for its last JSON line only, and a non-JSON last line is "the server answered something Tars cannot read", with the first 200 characters shown. Pinned in Task 2 (`reads the last json line past a login banner`).
2. **`docker exec` from a desktop marks every mint "on the server"** (seen in the trial: `docker exec` drops `SSH_CONNECTION`): the desktop names itself in the mint's `name` (its hostname; the client's kind says desktop, and the server files what it does as `<hostname> (machine)`), so `clients list` still tells the desktops apart. Pinned in Task 4 (`mints once with this machine's name`).
3. **The laptop sleeps with the forward up:** on wake the `ssh` is dead or hung; the 15 s keep-alive ends it within 45 s, the server reads offline, the retry owner reconnects with backoff and no second forward. Pinned in Task 6 (`one forward per server at most`, `offline within 45 s of silence`).
4. **A server rebuilt or recreated** (new container on the same home): the `serverId` is unchanged and the credential still admits; a `serverId` that changed is refused before the credential is sent ("this is not the server you connected to"), and only Forget then Connect accepts the new one. Pinned in Task 5 (`hello with another server id never gets the credential`).
5. **Typing while the link is failing:** batches leave in order, one in flight per agent, the first failure stops those behind it and the pane says not sent. Pinned in Task 8 (`keys keep their order and stop at the first failure`).

---

## File Structure (M2)

| File | Responsibility |
|---|---|
| `electron/services/cloud-link/ssh.ts` | host and runner checks, the remote command's words, `ssh` argv for a command and for the forward, `spawnSsh` (no shell) |
| `electron/services/cloud-link/remote-run.ts` | one remote command: spawn, stdin JSON, timeout, the last JSON line, `ssh`'s errors in plain words |
| `electron/services/cloud-link/store.ts` | `cloud-link.json` in `PRIVATE_DIR` (`writeSecretFileSync`), and the window's view of it without secrets |
| `electron/platform/local-forward.ts` | the local end: Unix socket path or free loopback port, per platform |
| `electron/services/cloud-link/forward.ts` | the long `ssh -N -L`: ready, alive, ended |
| `electron/services/cloud-link/link.ts` | Connect, Disconnect, Forget, Reconnect: status, start if down, mint once, forward, hello, retry owner |
| `electron/services/cloud-link/client.ts` | the door's routes through the forward: hello, fleet, screen, stream, drive |
| `electron/services/cloud-link/remote-fleet.ts` | ported poller: remote agents `c:<serverId>:<agentId>`, watched streams, typing queue |
| `electron/handlers/cloud-handlers.ts` | IPC for `window.electronAPI.cloud`; wired from `main.ts` |
| `src/lib/cloud.ts`, `src/hooks/useCloud.ts`, `src/hooks/useRemoteAgents.ts`, `src/hooks/useRemoteDrive.ts` | the window's side, ported from `lib/machines.ts` and the hooks |
| `src/components/Settings/CloudSection.tsx`, `src/components/ui/CloudBadge.tsx`, `src/components/CloudStopReason.tsx`, `src/components/TerminalsView/components/RemoteDriveBar.tsx` | the surfaces |
| `e2e/cloud-see-drive.spec.ts` | a sandboxed desktop and a headless server linked by a direct route (unpackaged only) |

## Tasks

### Task 1: `ssh.ts`, the argv and the checks (about 45 min)

**Files:** create `electron/services/cloud-link/ssh.ts`, `__tests__/electron/cloud-link/ssh.test.ts`, `__tests__/fixtures/fake-ssh.cjs`.

**Interfaces (produces):** `hostProblem(host: string): string | null`; `type ServerRunner`; `runnerProblem(runner: ServerRunner): string | null`; `type ServerCommand = { do: 'status' } | { do: 'start' } | { do: 'clients-add' } | { do: 'clients-list' } | { do: 'clients-revoke'; id: string }`; `remoteWords(runner, command): string[]`; `sshCommandArgv(host, runner, command): string[]`; `sshForwardArgv(host, localEnd: string, remoteSocket: string): string[]`; `spawnSsh(argv, opts?: { ssh?: { file: string; args: string[] } }): ChildProcess`.

- [x] Failures first in the test header: a host starting with `-`, holding whitespace or a control character, or a shell character, empty, over 255; a container or program word with a shell character or a leading `-`; a revoke id that is not `c_<8 hex>`; a socket path not absolute, holding `:` (it splits `-L`) or whitespace; `StrictHostKeyChecking` ever present; the host not right after `--`; a word that the remote shell would split or expand.
- [x] Tests: `refuses hosts that are not [user@]host`, `refuses runner words a remote shell would read`, `docker runner execs the server's cli with sudo -n`, `start goes through the runner`, `the host always follows --`, `never turns host key checking off`, `forward options are T3's plus BatchMode`, `the remote words parse back as themselves in sh` (POSIX only: `sh -c 'for w in <words>; do printf ...'`), `argv reaches ssh unchanged, no shell` (the fake `ssh` writes its argv to a file).
- [x] Implement; run `npx vitest run __tests__/electron/cloud-link/ssh.test.ts`; show one mutant red (a check removed); commit `feat: the cloud link's ssh argv, with the host and runner checks`.

### Task 2: `remote-run.ts`, one remote command (about 50 min)

**Interfaces:** `runServerCommand(profile: { host; runner }, command: ServerCommand, opts?: { stdin?: object; timeoutMs?: number; ssh? }): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; problem: SshProblem; detail: string }>`; `type SshProblem = 'ssh-missing' | 'host-key-unknown' | 'host-key-changed' | 'key-refused' | 'unreachable' | 'timeout' | 'sudo-password' | 'not-installed' | 'container-stopped' | 'unreadable' | 'refused' | 'failed'`; `problemSentence(problem, host): string`. Added while writing it: `ssh-missing` (no `ssh` on the desktop), `container-stopped` (`docker exec` on a stopped container fails before the CLI can say `running: false`, so Task 4 reads it as "down"), `refused` (a profile failing Task 1's checks, `ssh` never started).

- [x] Failures first: `ssh` missing on the desktop; host key unknown or changed (the sentence says to run `ssh <host>` once in a terminal); key refused; no route or DNS; hung past the timeout (killed, not left); `sudo` wanting a password; the CLI or container missing (exit 127, `No such container`); a login banner before the JSON; a non-JSON answer; a JSON line over 64 KB; stdin JSON never on the command line.
- [x] Tests drive the fake `ssh` (Task 1's fixture), told by an environment variable which stderr and exit to produce: `reads the last json line past a login banner`, `classifies ssh's own errors in plain words`, `kills a command past its timeout`, `clients add input goes on stdin`.
- [x] Commit `feat: the cloud link runs one server command over ssh`.

### Task 3: `store.ts`, `cloud-link.json` (about 30 min)

**Interfaces:** `type ServerProfile = { id: string; host: string; runner: ServerRunner; doorSocket?: string; serverId?: string; name?: string; clientId?: string; credential?: string }`; `readLink(file)`, `saveProfile(file, profile)`, `forgetProfile(file, id)`, `publicView(profile)` (no `credential`, ever).

- [x] Failures first: a missing or corrupt file reads as no server (and is not overwritten until the user saves); a profile failing Task 1's checks is refused at save; the file written 0600 in 0700; `publicView` never carries the credential (asserted on every key, recursively).
- [x] Commit `feat: the cloud link keeps its servers in the private folder`.

### Task 4: `link.ts` part 1, status, start if down, mint once (about 50 min)

**Interfaces:** `createCloudLink(deps: { file; run: typeof runServerCommand; hostname: () => string; forward: ForwardFactory; client: ClientFactory; now?; later?; random? })` returning `{ connect(id), disconnect(id), forget(id), state(id): LinkState, onState(fn) }`; `type LinkState = { phase: 'off' | 'connecting' | 'connected' | 'offline' | 'disconnected' | 'failed'; since?: string; problem?: SshProblem; sentence?: string }`.

- [x] Failures first: status not running then `start` then status again, once (no loop); `start` failing names its sentence; a mint answer without `id`, `credential` or `serverId` is refused and nothing is saved; a mint whose `serverId` differs from `status`'s is refused; Reconnect reuses the saved credential and never mints again by itself; Forget revokes its own id over SSH, then clears the profile even when the revoke cannot reach the server (said in the state).
- [x] Tests with fake `run`: `starts a server that is down, once`, `mints once with this machine's name`, `reconnecting reuses the credential`, `forget revokes then clears`.
- [x] Commit `feat: the cloud link starts the server if down and mints its credential once`.

### Task 5: the forward and `hello` (about 55 min)

**Files:** `electron/platform/local-forward.ts` (`localForwardEnd(serverKey): { kind: 'unix'; path } | { kind: 'tcp'; host: '127.0.0.1'; port }`, exported through `electron/platform/index.ts`), `electron/services/cloud-link/forward.ts` (`openForward(host, end, remoteSocket, { ssh? }): { ready: Promise<void>; ended: Promise<{ code; stderr }>; close() }`).

- [x] Failures first: `ssh` exits before ready (ExitOnForwardFailure: the port or path taken); ready never comes (timed out, killed); a stale local socket in our own folder is removed, anything else at that path is refused and left; the remote socket missing (`hello` fails: "the server's door is not there", which also catches a wrong `doorSocket`); `hello` answering another `serverId` never gets the credential; the credential sent only after `hello`.
- [x] Tests: the fake `ssh` proxies the forward to a door the test runs (a tiny `node:http` on a Unix socket or port): `hello with another server id never gets the credential`, `a forward that cannot bind ends the connect`, `closing the link ends the local ssh only`.
- [x] Commit `feat: the cloud link forwards to the server's door and checks it first`.

### Task 6: `link.ts` part 2, the retry owner (about 45 min)

- [x] Failures first: two Connects at once make one forward; the forward ending marks offline at once and schedules a retry (jittered, doubling from 2 s, capped at 5 min, reset after 60 s connected); silence (no keep-alive answer) ends `ssh` within 45 s (`ServerAliveInterval=15`, `CountMax=3`, asserted in the argv, and the state follows the process); a 401 from the door is `disconnected` with no retry and no mint; Disconnect during a backoff cancels it; quitting the app ends every local `ssh` and sends nothing to the server.
- [x] Tests with injected `now`, `later`, `random`: `one forward per server at most`, `backoff is jittered and capped at 5 min`, `a 401 reads as disconnected, not offline`, `a dropped link stops nothing on the server`.
- [x] Commit `feat: the cloud link reconnects by itself, one retry owner`.

### Task 7: `client.ts`, the door's routes (about 50 min)

Port `git show origin/win/machines:electron/services/machines/client.ts` to the door's routes and its transport (`socketPath` for a Unix end, `127.0.0.1:<port>` otherwise; `Host: localhost`).

- [x] Failures first: a refusal at the head (401, 403, 413) closes before the body is sent and is read as that status, not a broken link; a body over 4 MB from the door is cut; a stream's chunk split across reads; a stream the door ends (revoke) ends the pane's stream; no request without the credential except `hello`.
- [x] Tests against a door started in the test from `electron/services/cloud/door.ts` with a real client: `fleet and screen through the forward`, `a refusal at the head is not a broken link`, `revoke ends the open stream`.
- [x] Commit `feat: the cloud link speaks the door's routes` (landed as two commits: the routes, then the stream).

### Task 8: `remote-fleet.ts`, ported (about 55 min)

Port `remote-fleet.ts` and its 343-line test from `win/machines`: peers become connected server profiles, ids `c:<serverId>:<agentId>` (`parseCloudId`), `MAX_KEYS` from the door.

- [x] Keep the ported failures and add: `one fleet request in flight at most`, `reattaches a watched pane once after offline`, `keys keep their order and stop at the first failure`, `an outside-agent ceiling on keys reads as the server's sentence`.
- [x] Commit `feat: the server's agents as the desktop keeps them`.

### Task 9: `cloud-handlers.ts`, preload and `electron.d.ts` (about 50 min)

**Interfaces:** `window.electronAPI.cloud`: `list(): ServerView[]`, `save(profile)`, `connect(id)`, `disconnect(id)`, `forget(id)`, `clients(id)`, `revoke(id, clientId)`, `agents(): RemoteAgent[]`, `onAgents(fn)`, `onState(fn)`, `screen(remoteId)`, `watch(remoteId)`, `unwatch(remoteId)`, `onOutput(fn)`, `drive(remoteId, action, body)`, `keys(remoteId, data)`, `resize(remoteId, cols, rows)`.

- [x] Failures first: no server configured means no `ssh` spawned and no timer (`off by default, no ssh`); a window call with a remote id of another shape is refused; nothing returned to the window holds `credential`, `doorSocket` or a host key line.
- [x] `preload.ts` and `src/types/electron.d.ts` in the same commit; `main.ts` gets the one wiring line, guarded `if (!HEADLESS)`.
- [x] Commit `feat: the window reaches the cloud link`.

### Task 10: Settings > Cloud, frames first (about 45 min, then Nicolas's look)

- [x] (one frame, dark: `Settings · Cloud`, from `Settings · Machines`; the light copy and a states frame wait for his look) Draw in `design/tars-redesign.pen` through the `pen` CLI: the section empty, a server being added (host, "How the server runs": "Installed" with the command, or "Docker" with container, sudo and the socket path), connected, offline since, disconnected by the server with Reconnect, a failed connect with its sentence, the clients list with Revoke; dark and light. Add the surface to `design/UI-INVENTORY.md` and `e2e/surfaces.mjs`.
- [ ] Export the frames, show them to Nicolas, wait for his go before Task 11.

### Task 11: Settings > Cloud, the TSX (about 55 min)

- [x] (waiting for Nicolas's look) `CloudSection.tsx` from the frames, through `src/components/ui/` only, controls 26 or 32 px; `useCloud.ts`; the sentences from Task 2's `problemSentence`, not retyped.
- [x] Unit for `src/lib/cloud.ts` view logic (failures first); `npm run lint:design`; commit `feat: settings has a cloud section to connect a tars server`.

### Task 12: the server's agents in Dashboard and Agents (about 55 min)

- [x] Port `lib/machines.ts` (the remote half) into `src/lib/cloud.ts`, `useRemoteAgents.ts`, `MachineBadge` as `CloudBadge` (the `--machine-ink` token, renamed only if Nicolas asks), the filter ("This Tars", then each server), the offline line; frames first for any surface that changes.
- [x] Ported `__tests__/lib/machines.test.ts` cases, failures first for the merge (a remote id never collides with a local one; an offline server's agents keep their last state).
- [x] Commit `feat: a tars server's agents in dashboard and agents` (with Task 13, one commit: they share every file).

### Task 13: driving a server's agent from the window (about 55 min)

- [x] Port `useRemoteDrive.ts`, `RemoteDriveBar.tsx`, `MachineStopReason.tsx` as `CloudStopReason.tsx`: the live pane, typing through the queue, Drive panes send their size, See panes scale the remote size to fit, start, stop with a reason, message.
- [x] Commit `feat: drive a tars server's agent from this tars` (landed in Task 12's commit).

### Task 14: E2E `e2e/cloud-see-drive.spec.ts` (about 55 min, run on CI)

- [x] The spec starts a headless server (`node electron/dist/server/cli.js serve` in its own HOME with the fake CLI) and a sandboxed desktop whose link takes a direct route to the server's door socket (`TARS_CLOUD_DIRECT=<socket>`, read only when `!app.isPackaged`, refused otherwise: a unit pins it), so CI needs no SSH.
- [x] Asserts and leaves in its run directory: the server's agent in Dashboard with the badge, its live output, keys typed reaching the fake CLI's transcript, a stop with a reason, the offline line when the server process is stopped, the same pane again when it is back; the JSON of asserted values and the reproducing command.
- [x] Shown to bite: the direct route pointed at a socket with another server id turns it red. Runs on the fork's CI (no local E2E on this PC). Done instead with a mutant (the pane's cloud:output listener emptied: red at the live step), and the spec alone was run here with E2E_PORT_OFFSET=40 (passed).

### Task 15: docs, then the real test with Nicolas (about 45 min, then his session)

- [ ] `SECURITY.md` §8, the desktop's side: SSH is the authority, the local end and its Windows residual, what the window never sees; `OPERATIONS.md`: connecting a desktop, the Docker runner, Forget and Revoke; the trial runbook's step for the M2 rebuild (`git fetch` and `build.sh` in `tars-build`, then recreate `tars-server` on the same volume and home).
- [ ] With Nicolas, on his go: rebuild the server at the M2 head; connect from the PC and the Mac; see and drive from both; restart the container; drop the Mac's Wi-Fi; revoke one client from the other; `ss -lx` and `ss -ltn` on the server show nothing new on a network.
- [ ] A fresh security review of M2 (one round, blocking issues only), then the plan's status lines.

## Estimates

| Task | What | Estimate |
|---|---|---|
| 1 | `ssh.ts` argv and checks | 45 min |
| 2 | `remote-run.ts` | 50 min |
| 3 | `store.ts` | 30 min |
| 4 | link: status, start, mint | 50 min |
| 5 | forward and `hello` | 55 min |
| 6 | retry owner | 45 min |
| 7 | `client.ts` | 50 min |
| 8 | `remote-fleet.ts` port | 55 min |
| 9 | handlers, preload, types | 50 min |
| 10 | Settings frames | 45 min, then Nicolas |
| 11 | Settings TSX | 55 min |
| 12 | agents in Dashboard and Agents | 55 min |
| 13 | drive from the window | 55 min |
| 14 | E2E | 55 min, plus CI |
| 15 | docs, real test, review | 45 min, then his session |
| | **Total** | **about 12.5 hours of work**, plus CI runs, Nicolas's look at the frames, and the real test |

Tasks 1 to 9 need nothing from Nicolas and can run tonight and tomorrow; Task 10 waits for his look before 11 to 13; Task 15's real test is his session.

## Follow-ups (not in M2's tasks)

- **A minted credential this desktop discards is never revoked** (security review 1, nit 5, `link.ts`): the mint's answer is dropped when it comes after Disconnect or Forget, fails the checks (`mint-refused`), or `saveProfile` throws, and the client stays on the server. Revoke it over SSH right away when its id is readable, or say in Settings which client to revoke.
- **hello with a nonce** (security review 1, nit 3, the stronger fix): the door proves it knows the credential (HMAC of sha256(credential) over the desktop's nonce) before the desktop sends it, so the Windows loopback end no longer rests on ssh holding the port. SECURITY.md §8 says the residual today.
- **Settings > Cloud after Nicolas's look**: the light copy and a states frame, the frame's header button (drawn "Add a server", built as the section's own first rows), and the surfaces baseline picture once approved.
