# Tars cloud M3: create a cloud project or agent from the desktop. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** from a desktop linked to a Tars server (M2), the user creates a project on the server (empty, or cloned from a git URL) and creates agents in it, from the same New project and New agent forms as for a local project. The agents are made by the server, run there, and appear in the Dashboard and the Agents page as M2's do. The server's operator can do the same over SSH without a window.

**Architecture:** the server gains two door routes with the `create` scope, `POST /cloud/v1/projects` and `POST /cloud/v1/agents`, and the fleet answer gains the server's projects. Both routes call functions shared with the rest of Tars: one agent-creation function in `electron/core/` (the checks `POST /api/agents` makes today, moved, not copied) and one project-creation function in `electron/services/cloud/`. An agent is created as a record only; starting it stays M2's drive `start`, which goes through `initAgentPty` (the spawn rule: `spawnAgentSession` and `initAgentPty`, no third way). Every start on the server first checks the memory left on the box. The desktop's client, handlers and preload gain `createProject`, `createAgent` and `projects`; the window's forms ask Local or Cloud.

**Spec:** the M1 plan's outline "M3: create a cloud project or agent" and its Global Constraints (all apply); the M2 plan (its constraints, its door, its link); the real test of 2026-11-03 (`reports/2026-11-02-tars-server-trial.md`, sections "Test agent", "The PATH fix"); the frames Tars Design is drawing in `design/tars-redesign.pen`: `New project · where`, `New agent · cloud project`, `Projects · with cloud`.

## What the real test of 2026-11-03 taught (each is a constraint below or a task)

1. **The headless server has no way to create an agent.** Its CLI has none, and `POST /api/agents` refuses a caller with no agent identity, by design. `Test cloud` was written into `agents.json` by hand, the server stopped. M3 gives the server two ways that share one function: the door (Task 4) and the server's own CLI (Task 5).
2. **A login shell may replace PATH.** Debian's `/etc/profile` does, and the server's HOME has no `~/.profile`: `claude` in `~/.local/bin` was "command not found". Fixed in 724edf7d (`TARS_AGENT_PATH`, put back by `toLaunch` on Linux). M3's E2E and real test start an agent on the server and check its CLI runs, so the fix stays proven.
3. **On Docker, the door path is not found for you.** The container's `status` names its own path, which the host does not have, so Settings > Cloud asks for it under Advanced. Task 6 lets the container say the host's path.
4. **The VPS has little memory to spare.** About 2 GB free, Hermes about 1.1 GB, a build bottomed at 1.16 GB. Each Claude Code agent costs about 300 MB. M3 refuses to start an agent that would leave the box under 1 GB, with a clear sentence (Task 3).
5. **A desktop's client was minted with `see` and `drive` only.** Creating needs `create`. Decision 3 below says how an existing desktop gets it.

## Decisions for Nicolas, before Task 1

1. **Where projects live on the server.** Recommended: `~/projects` in the server's HOME (`/home/tars/projects` in the container, on the bind mount), where `Test cloud` already is; a setting of the server can move it. The M1 outline said `~/tars-projects`.
2. **Which git URLs the server clones.** Recommended for M3: public `https://` only, no credential of the desktop ever sent. Private repositories later, with a deploy key or token Nicolas installs in the container himself.
3. **How this computer gets `create`.** Recommended: new mints get `see`, `drive` and `create`; an existing desktop gets it with Forget this server then Connect (a new client), not a silent upgrade of an existing credential. Outside agents (Hermes) never create in M3, whatever their scopes.

## Global Constraints (M3's own, on top of M1's and M2's)

- **One creation path per thing.** An agent is created by `createAgentRecord` in `electron/core/agent-create.ts`, which `POST /api/agents`, the door and the server's CLI all call. A project is created by `createProject` in `electron/services/cloud/projects.ts`, which the door and the server's CLI call. No second copy of the checks.
- **The spawn rule holds.** Creating an agent writes its record and nothing else: no PTY, no worktree, no CLI. It starts through M2's drive `start`, which calls `initAgentPty`. Nothing in M3 spawns a process but `git clone` (Task 2).
- **Names through the guards.** A project name is one path segment: `isUnsafePathSegment` (`electron/platform/windows-names.ts`), no `.` or `..`, no leading `.` or `-`, 1 to 100 characters of `[A-Za-z0-9._ -]`. The path it makes must be under the projects root (`isUnder`, `electron/platform/path-compare.ts`), the root must be a real folder (not a link), and the project folder must not exist yet: nothing is overwritten or merged.
- **Git URLs.** `https://` only in M3 (decision 2), parsed with `URL`: no user or password in it, a host, a path. Refused before git runs: `file:`, `ext::`, `ssh://`, scp-like `host:path`, a local path, anything starting with `-`, any whitespace or control character, over 2048 characters. `git clone` runs by `execFile` with an argv (`clone --no-recurse-submodules --depth 1 -- <url> <dir>`), `GIT_ALLOW_PROTOCOL=https`, `GIT_TERMINAL_PROMPT=0`, the repository's own programs off (the options `electron/utils/safe-git` already uses), a timeout, and its output cut. A failed clone removes the folder it started.
- **`create` is a scope the door checks**, as `see` and `drive` are (403 without it). A client of kind `outside-agent` is refused `create` even if it holds the scope.
- **Memory before every start on the server.** `memoryHeadroom()` in `electron/platform/` reads the box's available memory (`MemAvailable` in `/proc/meminfo`) and, in a container, what the cgroup still allows (`memory.max` minus `memory.current`), and takes the smaller. A start that would leave less than the floor (1024 MB by default, the server's setting `cloudMinFreeMb`) is refused: "Not started: this server has 640 MB of memory free, and Tars keeps 1 GB for the rest of it." The estimate per agent is 300 MB. The check runs in the server's start path, so M2's drive `start`, a start after create and the operator's start all meet it.
- **What the window receives.** Project paths on the server are shown as the server names them; no credential, no git token, no host path beyond what `status` already says.
- **No em dash**, no real address in a committed file, author `91372699+Nexarion434@users.noreply.github.com`.

## Review Focus

1. **A name or URL that escapes.** `../x`, `x/..`, `.git`, a Windows reserved name, a link planted at the projects root, `https://user:pw@host/x`, `--upload-pack=...`, `ext::sh -c ...`, `file:///etc`. Pinned in Tasks 2 and 4 (`a project name never leaves the root`, `a url outside https is refused before git runs`).
2. **A client that may not create.** A desktop minted before M3 (`see`, `drive`), an outside agent with `create`. Pinned in Task 4 (`create without the scope is 403`, `an outside agent never creates`).
3. **A second way to spawn.** Creating with `start: true` must go through the same drive `start`, never a direct `initAgentPty` or a `spawnAgentSession` call from the door. Pinned in Task 4 (`create writes a record and spawns nothing`).
4. **Memory.** A start at 900 MB free is refused with the sentence, and nothing is spawned; the floor read from the cgroup when it is lower than the host's. Pinned in Task 3.
5. **The clone that hangs or fills the disk.** The timeout kills it and the folder goes; a clone over the size cap (2 GB by default) is stopped. Pinned in Task 2.

---

## File Structure (M3)

| File | Responsibility |
|---|---|
| `electron/core/agent-create.ts` | `createAgentRecord(fields, ctx)`: every check `POST /api/agents` makes today, the record, `saveAgents`, the announce; no spawn |
| `electron/services/cloud/projects.ts` | the projects root, `projectNameProblem`, `gitUrlProblem`, `createProject(name, from)`, `listProjects()` |
| `electron/platform/memory-headroom.ts` | `memoryHeadroom()`: host `MemAvailable` and the cgroup's room, the smaller |
| `electron/services/cloud/door.ts` | two `create` routes, `projects` in the fleet answer |
| `electron/server/cli.ts` | `projects add --json`, `agents add --json` (stdin), for the operator |
| `electron/services/cloud-link/client.ts`, `electron/handlers/cloud-handlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts` | `createProject`, `createAgent`, `projects` for the window |
| `src/components/...` (New project, New agent, Projects) | Local or Cloud, from the three frames |
| `e2e/cloud-create.spec.ts` | a cloud project and an agent created from the desktop, started, its CLI running on the server |

## Tasks

### Task 1: `agent-create.ts`, one creation path (about 50 min)

Move the checks of `POST /api/agents` (`electron/services/api-routes/agent-routes.ts`: provider, permission mode, plan mode, CLI path, skills, model, effort, role refused as orchestrator, the name's `, task t-`, the API-key refusal) into `createAgentRecord`. The route keeps its caller checks (`resolveDriver`, `mayActIn`) and calls it.

**Interfaces:** `createAgentRecord(fields: NewAgentFields, ctx: { agents; saveAgents; appSettings; announce }): { ok: true; agent: AgentStatus } | { ok: false; status: 400 | 403; error: string }`.

- [ ] Failures first: each refusal the route makes today still refused with the same status and sentence (the route's existing tests stay green unchanged); the record has exactly today's fields and defaults (`permissionMode` `auto`, `role` `worker`); nothing spawns (no PTY, no worktree); an orchestrator role refused before anything is written.
- [ ] Tests: the route's tests unchanged, plus `agent-create.test.ts` on the function alone.
- [ ] Commit `refactor: one function creates an agent record`.

### Task 2: `projects.ts`, a project on the server (about 55 min)

**Interfaces:** `projectsRoot(settings): string` (decision 1); `projectNameProblem(name): string | null`; `gitUrlProblem(url): string | null`; `createProject(name, from: { kind: 'empty' } | { kind: 'git'; url }, deps): Promise<{ ok: true; path } | { ok: false; status; error }>`; `listProjects(): Array<{ name; path }>` (the root's folders plus the server's `projects.json`).

- [ ] Failures first: every name in Review Focus 1 refused, and a name already taken; a root that is a link or missing (created 0700 when missing, refused when a link); each URL in Review Focus 1 refused before git runs (a fake `git` records it never ran); a clone that fails, hangs past the timeout or passes the size cap leaves no folder; git's argv has the URL after `--`, its env has `GIT_ALLOW_PROTOCOL=https` and `GIT_TERMINAL_PROMPT=0`; an empty project is a folder with `git init` (so worktrees work) and nothing else.
- [ ] Tests with a fake `git` (`__tests__/fixtures/fake-git.cjs`), no network.
- [ ] Commit `feat: the server creates a project, empty or cloned`.

### Task 3: memory before a start (about 45 min)

**Interfaces:** `memoryHeadroom(deps?: { readFile }): { availableMb: number; source: 'host' | 'cgroup' }` in `electron/platform/memory-headroom.ts` (exported through `platform/index.ts`; on macOS and Windows `os.freemem()`); the server's start path asks `startAllowed(headroom, floorMb, perAgentMb)` before `initAgentPty`.

- [ ] Failures first: 900 MB free refused with the sentence and nothing spawned; the cgroup's room used when lower than the host's (`memory.max` `max` read as no limit); an unreadable `/proc/meminfo` does not block a start (said once in the log); the floor from the server's setting, 1024 by default; a desktop's local agents never checked (the check is the server's).
- [ ] Mutant: the comparison turned around, red.
- [ ] Commit `feat: the server keeps 1 gb free before it starts an agent`.

### Task 4: the door's `create` routes (about 55 min)

`POST /cloud/v1/projects` `{ name, from }` and `POST /cloud/v1/agents` `{ projectName | projectPath, name, provider, model, effort, permissionMode, skills, character, start? }`, scope `create`; `GET /cloud/v1/fleet` gains `projects`. An agent's project must be one of `listProjects()`. `start: true` calls the drive `start` after the record exists (Task 3's check included).

- [ ] Failures first: `create without the scope is 403`; `an outside agent never creates`; a project path outside the server's projects refused; `create writes a record and spawns nothing` (without `start`); a body over the door's 64 KB cap is 413; the fleet's `projects` carries names and paths only; each refusal of Tasks 1 to 3 comes back with its status and sentence.
- [ ] Tests against a door started in the test, as M1's door tests do.
- [ ] Commit `feat: the door creates projects and agents for a client with create`.

### Task 5: the server's CLI, for the operator (about 40 min)

`node electron/dist/server/cli.js projects add --json` and `agents add --json`, input on stdin as `clients add` does, through Tasks 1 and 2's functions, against the running server (through its local API with the server's own pass) so the server's memory and `agents.json` stay one; refused when the server is not running.

- [ ] Failures first: input never on the command line; the server down is a clear exit 1; the same refusals as the door.
- [ ] Commit `feat: the server's cli adds projects and agents`.

### Task 6: the door path on Docker, found for you (about 40 min)

The container is started with `-e TARS_DOOR_ON_HOST=/home/<user>/tars-cloud/home/.tars-private/door.sock`; `status --json` names it as `doorOnHost`; the desktop uses it when its profile has no `doorSocket`, and Advanced's note can then say the door path is filled in for you. The runbook's `docker run` gains the variable.

- [ ] Failures first: a `doorOnHost` that is not absolute, holds `:` or whitespace, is refused as `doorSocket` is today; a profile's own `doorSocket` wins; without the variable, today's behaviour.
- [ ] Commit `feat: a docker server says where its door is on the host`.

### Task 7: the desktop's side (about 50 min)

`client.ts` `createProject`, `createAgent`; `cloud-handlers.ts` and `window.electronAPI.cloud.createProject(id, body)`, `createAgent(id, body)`, `projects(id)` in `preload.ts` and `electron.d.ts`, one commit; new mints ask `see`, `drive`, `create` (decision 3); the server's `projects` kept per server for the window.

- [ ] Failures first: a window call with a server id of another shape refused; nothing returned holds a credential; a 403 for `create` says "This computer may see and drive this server, not create on it: Forget this server, then Connect again to allow it." (decision 3); the existing M2 tests unchanged.
- [ ] Commit `feat: the desktop asks a server to create`.

### Task 8: New project, Local or Cloud (about 55 min, frames first)

Frames: `New project · where`, `Projects · with cloud` (Tars Design). New project asks where, Local (today's form) or a connected server; for a server, a name and Empty or From a git URL; the server's sentence shown as it came. The Projects list shows a server's projects with its badge.

- [ ] Failures first in the TSX's unit: no server connected means no Cloud choice; a name the server refuses keeps the form filled.
- [ ] Commit `feat: a new project can be made on a tars server`.

### Task 9: New agent in a cloud project (about 50 min, frame first)

Frame: `New agent · cloud project`. In a server's project, New agent sends the form's fields to the server (Task 7); the agent appears through the fleet as M2's agents do; Start is M2's. A provider whose CLI the server has not got is the server's sentence, not a crash.

- [ ] Failures first: the window never creates a local record for a cloud project; the memory refusal shown on the card as the server said it.
- [ ] Commit `feat: a new agent in a cloud project is made on its server`.

### Task 10: E2E `e2e/cloud-create.spec.ts` (about 55 min, run on CI)

Through M2's direct route (unpackaged only): the desktop creates an empty cloud project, then an agent in it on the recording fake CLI, starts it, and sees its terminal live; a second start with the memory floor set above the box's free memory is refused with the sentence. Leaves values and a picture per step. Its stop must turn red on the old build (no route: 404) and on a mutant that skips the `create` scope.

- [ ] Commit `test: a cloud project and its agent, created from the desktop`.

### Task 11: docs, the security review, the real test (about 45 min, then Nicolas's session)

SPECS §9b (create), OPERATIONS (projects root, the operator's CLI, the memory floor), SECURITY.md §8 (create, names, URLs, the memory floor), changelog and version. A fresh security review of the diff. The real test on the VPS: a project cloned from a public repository, an agent on Haiku in it, started from the PC, then from the Mac; one start refused by the memory floor (the floor set high for the test, set back after).

- [ ] Commit `docs: creating on a tars server`.

## Estimates

| Task | Estimate |
|---|---|
| 1 agent-create | 50 min |
| 2 projects | 55 min |
| 3 memory | 45 min |
| 4 door routes | 55 min |
| 5 server CLI | 40 min |
| 6 Docker door path | 40 min |
| 7 desktop side | 50 min |
| 8 New project | 55 min |
| 9 New agent | 50 min |
| 10 E2E | 55 min |
| 11 docs and real test | 45 min |
| **Sum** | **about 9 h 20 of work** |

With a review round per task, CI runs and the security review, about 2.5 days of calendar time, as the M1 outline said (2.5 to 3.5 days). Task 6 can wait for M4 if time is short; Tasks 1 to 5 come first and can ship alone (the operator's CLI already removes the hand-seeding).

## Follow-ups (not in M3)

- Private git repositories (decision 2): a deploy key or a token in the container, never the desktop's.
- A cap on running agents per server beside the memory floor, if the floor alone proves too coarse.
- Files (the `files` scope): reading a cloud project's files from the desktop.
