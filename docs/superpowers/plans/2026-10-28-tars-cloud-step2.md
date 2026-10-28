# Tars cloud, step 2: a spoke sees and drives a hub's agents. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Tars that pairs with a hub Tars on the same tailnet shows the hub's agents mixed into its Dashboard and Agents page (machine badge, machine filter, offline line), with a live terminal it can type into and size, and starts, stops (with a reason) and messages them where the hub allows Drive. Off by default: a Tars with no pairing and serving off behaves exactly as `upstream/main`.

**Architecture:** one Tars may *serve* (the hub: opt-in, a second `node:http` server bound to its Tailscale IPv4 only, port 31418, routes allow-listed one by one) and any Tars may *reach* hubs (a spoke: no listener ever, it polls the hub's fleet every 3 s, reads one SSE stream per open pane, and POSTs drive actions). Pairing is the fork's knock, Accept, proof-of-code protocol made one-way: the hub shows the code and issues the only secret, the spoke presents it. Every call goes spoke to hub, in this step and the later ones, so step 4's relay is new routes on the same server, not a new direction.

**Tech Stack:** Electron 44.9 main process (TypeScript, `node:http`, `node:crypto` scrypt/HMAC), the `tailscale` CLI through `execFile`, Next.js 16.4 renderer (React 19, xterm 5), vitest for units, Playwright with two sandboxed Tars on one machine for E2E, the `pen` CLI for frames.

**Spec:** the Tars cloud decisions taken with Nicolas on 2026-10-28 (hub/spoke roles, steps 2 to 5, the non-negotiables copied into Global Constraints below). Prior art, validated for real Mac + PC on 2026-10-09, read with `git show origin/win/machines:<path>`: its plan `docs/superpowers/plans/2026-10-02-machines-bridge.md`, its `SECURITY.md` §8 "The machines bridge" (the threat analysis this plan keeps), and the frames `Settings · Machines`, `Dashboard · two machines`, `Panel · machine offline`, `Agents · two machines`, plus the two pairing frames, on the fork's `win/multi-machine-design` (commit 52742226) and `win/machines`.

## Global Constraints

- **Tailnet only.** The bridge binds this machine's Tailscale IPv4 or nothing: never `0.0.0.0`, never `::`, never Funnel, never `tailscale serve`. A caller outside `100.64.0.0/10` gets 403 (macOS hands a socket bound to the tailnet address what arrives over the LAN for it too). A development run (`app.isPackaged === false`) may set `TARS_MACHINES_BIND`, `TARS_MACHINES_PORT`, `TARS_MACHINES_PEERS`; a packaged Tars never reads them (the rule `DOROTHY_TAILSCALE_BIN` already follows).
- **Off by default.** `serve` is false in a new install: no listener, no route, no Tailscale call beyond what Settings > Hermes already makes. A Tars that reaches no hub polls nothing. Every existing E2E surface keeps its reference screenshot; the only new surface is `settings-machines`.
- **The master API token never leaves its machine.** `~/.tars-private/api-token`, Tars's own pass, agents' tokens, the bridge token (`services/bridge-token.ts`) and Hermes gateways' secrets are never sent to a hub and never accepted by one. The bridge admits one credential: the secret the hub issued to that spoke at pairing (32 random bytes, base64url, 43 characters), kept on the hub as its sha256 and compared in constant time.
- **A machine is driven only if it allowed Drive.** The hub decides per spoke (`see` or `drive`), re-reads its private file at each request and again once the body is in; the spoke's own idea of what it may do (`youMay` in the fleet) only shapes its window and is never trusted by the hub.
- **Spokes always call the hub.** No route, poll, callback or push from a hub to a spoke, now or in steps 3 to 5. A spoke never opens a listening socket.
- **Secrets on disk:** `~/.tars-private/machines.json`, written with `writeSecretFileSync` (`electron/utils/secret-file.ts`: `0600` in a `0700` folder, an owner-only ACL on Windows), never handed to a CLI, never sent to the window (the view carries no secret and no hash). `serve` lives there too, not in `app-settings.json`, which every agent can write.
- **Routes listed one by one:** an unknown path is a 404 before a credential is read; a request carrying `Origin` is a 403 (no browser calls the bridge); a body over 64 KB is a 413 unread; no route of the loopback API answers on the bridge.
- **Upstream shape:** new code in new files (`electron/services/machines/`, `electron/handlers/machines-handlers.ts`, `src/components/Settings/MachinesSection.tsx`, `src/components/ui/MachineBadge.tsx`, `src/hooks/useMachines.ts`, `src/lib/machines.ts`); edits to upstream files are wiring only. `electron/preload.ts` and `src/types/electron.d.ts` change in the same commit. `execFile` with an argv array for `tailscale`. No `if (win32)` outside `electron/platform/`.
- **Pencil first:** each frame is drawn in `design/tars-redesign.pen` through the `pen` CLI (never the `pencil` MCP tools) and shown to Nicolas before its TSX; the new surface goes into `design/UI-INVENTORY.md` and `e2e/surfaces.mjs` in the same change (`npm run e2e:guard`).
- **Every user-visible PR carries:** its changelog entry and version bump (`src/data/changelog.ts`, `package.json`: extend the top entry only while `gh release list --repo cooper-labs-tech/Tars` shows it uncut), the docs it falsifies (`README.md`, `SPECS.md`, `OPERATIONS.md`, `DESIGN.md`, `SECURITY.md`), and screenshots from `--update-snapshots` when a surface changed.
- **Copy:** English, Tars's voice, no em dash or en dash anywhere (`npm run check:dashes`), `npm run check:names` clean. Controls 26 or 32 px, tokens only, `npm run lint:design` clean.
- **Tests:** E2E first (two sandboxed Tars in one spec), units written failures first with the failure list in the test file's header, each test shown to bite (a mutant or the old build turns it red), each E2E run leaves its artefact (`E2E_TRACE=on`, screenshots, the JSON of asserted values, the command that reproduces it).
- **Git:** branches start from `upstream/main` only. Never merge, rebase onto or cherry-pick from `windows`, `win/*` or any branch of the fork's old history; old code is read with `git show origin/win/machines:<path>` and typed again. Before every commit: `git config user.email` and, after it, `git log -1 --format='%an <%ae>'` both show `91372699+Nexarion434@users.noreply.github.com`. Push to `origin` (the fork) only; nothing goes to `cooper-labs-tech/Tars` without Nicolas's explicit go. This plan file stays on the fork: each PR branch is cut from `upstream/main` and takes its PR's commits, not this file.
- **This Windows PC:** never run vitest mutants or an E2E run beside `npm test` (the load times out unrelated files); a symlink test failing locally with EPERM is checked on the CI Windows job first; a green `Tests` line with an `Unhandled Errors` block is a failure (check the exit code).

## Review Focus

1. **The hub's tailnet address goes away and comes back** (the server reboots, `tailscaled` restarts, Tailscale is logged out as happened on the PC on 2026-10-09): the bridge reports "not listening" with the reason, never falls back to another address, and listens again at the next check once the address is back. Pinned in Task 4 (`rebinds once the tailnet address returns`).
2. **The hub quits or the network drops while a spoke watches** (a nomad on hotel Wi-Fi or a phone's hotspot): the spoke keeps the hub's last agents marked offline with "offline since", ends the stream within 45 s of silence, never stacks two fleet requests, and reattaches each open pane once without duplicating it when the hub answers again. Pinned in Task 10 (`one fleet request in flight at most`, `reattaches a watched pane once after offline`) and Task 11's E2E (quit and restart the hub).
3. **Keys typed while the link is slow or failing:** batches leave in order, one at a time; a batch the hub refused or never answered is shown as not sent in the pane, and nothing typed after it is sent ahead of it. Pinned in Task 15 (`keys keep their order and stop at the first failure`).
4. **Two viewers on one agent** (the hub's own window and a spoke, or two spokes): the terminal takes the size of whoever typed or clicked last, and no viewer resizes in a loop when the other answers. Pinned in Task 13 (`size from a spoke does not echo a resize back`) and Task 15's E2E.
5. **A spoke forgotten on the hub while it was off:** at its next call it reads "Forgotten by <hub>" with a Forget button, not "offline" for ever, and every stream that spoke held is cut at the Forget. Pinned in Task 5 (`401 reads as forgotten`) and Task 9 (`forget cuts that spoke's streams at once`).

---

## Roles and settings

| | Hub (serves) | Spoke (reaches) |
|---|---|---|
| Turned on by | Settings > Machines > "Let my other machines reach this Tars" (off by default; kept in `~/.tars-private/machines.json`) | Settings > Machines > "Reach another Tars", once per hub |
| Listens | its Tailscale IPv4, port 31418, while serving is on | never |
| Pairing | shows a 6-digit code (5 min); a knock shows "<MagicDNS name> (<address>) wants to reach this Tars" with Refuse / Let it see / Let it see and drive | lists the tailnet peers showing a code (`hello`), the person picks one and types the code |
| Holds | per spoke: id, name, device, address, sha256 of its secret, `may: 'see' \| 'drive'`, last seen | per hub: id, name, address, port, the secret |
| Shows | the machines that reach it, last seen, a See / Drive switch and Forget for each | the hubs it reaches, connected / offline / forgotten, Forget; their agents in Dashboard and Agents |

A Tars may do both (the code has no hub-only branch): Mac and PC could still reach each other directly, as the fork did, by each serving. The topology of steps 4 and 5 (spokes reach the hub only) is a choice of the user, not a restriction in code. A Tars that serves needs nothing on the spoke side open: the Windows firewall trap measured on 2026-10-05 (Tailscale packets classified as profile 0) only concerns a Windows hub, and is written down in OPERATIONS.md as such.

## What is ported, what is new

| Piece | From `origin/win/machines` | Change in this plan |
|---|---|---|
| Tailscale status | `tailscale-status.ts` (moved out of `hermes-handlers.ts`) | same move again: upstream still keeps `detectTailscale` private at `electron/handlers/hermes-handlers.ts:279`; peers and `deviceAt` added |
| Store | `store.ts`, `types.ts` | one secret per pairing instead of two; `serve`, `spokes[]`, `hubs[]` instead of `peers[]` |
| Pairing | `pairing.ts` (scrypt N 2^15 r 8 over both nonces, HMAC proof and answer, 5 min, 5 tries) | unchanged |
| Bridge | `bridge-server.ts` (13 routes) | agent routes carry the machine id; the fleet answers a list of machines; accept takes `see` or `drive` |
| Client and status | `client.ts`, `status.ts` (both sides pinged each other) | spoke side only; the hub knows a spoke by its last request |
| Fleet | `fleet-share.ts`, `fleet-source.ts`, `remote-fleet.ts` | `fleet-source.ts` splits into `fleet-source.ts` (read side) and `drive.ts` (transport-agnostic executor for step 4) |
| Sender line | `{ kind: 'machine' }` in `MessageSender` | same, plus the `machine` source in the task ledger (deferred in the fork) |
| Renderer | `MachinesSection.tsx`, `MachineBadge.tsx`, `MachineStopReason.tsx`, `useMachines.ts`, `lib/machines.ts` | Settings in two halves (this Tars serves / Tars this one reaches); remote start and stop in the context menu (hidden in the fork) |
| E2E | `machines-pairing.spec.ts`, `machines-see.spec.ts` | rewritten for one hub and one spoke; `machines-drive.spec.ts` new (the fork proved Drive with units) |
| New | | the fork's deferred minors that touch this scope: busy state on Connect, the "No machine shows a code" sentence names Tailscale's access rules, watch counts released on window reload, the hub's name editable |

## How steps 3, 4 and 5 fit without rework

Three decisions of this step are what make the later ones additive:

1. **The fleet answers a list of machines.** `GET /machines/v1/fleet` returns `{ v: 1, machines: [{ id, name, youMay, agents }] }`. In step 2 the list holds the hub alone. In step 4 the hub adds the spokes that push to it; the spoke's `remote-fleet.ts` already keys agents by their origin machine and keeps `via` (the hub it came through), so a relayed PC agent on the Mac is `m:<pcId>:<agentId>` via the hub, with no client change.
2. **Agent routes name the machine.** `/machines/v1/machines/:machineId/agents/:agentId/<action>`. In step 2 a `machineId` other than the hub's own is a 404. In step 4 the hub relays an action for a pushing spoke's agent instead.
3. **Driving is one executor, not one transport.** `drive.ts` exports `executeDrive(request, caller)`; the bridge routes call it in step 2. In step 4 a spoke opens `GET /machines/v1/push/commands` (SSE, spoke to hub, same secret) and runs each command through the same `executeDrive`, after checking *its own* list of machines allowed to drive it: the driven machine decides, as in step 2. Its fleet goes up with `POST /machines/v1/push/fleet` and its terminals with `POST /machines/v1/push/agents/:id/output`, all spoke-initiated.

Step 3 (create a project or an agent on the hub) is a third, separate permission on the hub's spoke row (`mayCreate`, off by default) and its own routes; nothing in step 2 grants it. Step 5 (Hermes as a client) is one more entry in the hub's `spokes[]` with `kind: 'hermes'`, its own secret and its own name on every action ("by Hermes"): the same store, the same per-caller secret, the same `by` naming as a machine's.

## PR split and estimates

Estimates are working time for one implementing agent, with the upstream gates (frames, E2E with artefact, a mutant per spec, docs, changelog) and one security review round per PR; Nicolas's review waits are not counted.

| PR | Tasks | What a user gets | Estimate |
|---|---|---|---|
| (spike, no PR) | Task 0 | evidence that a Tars runs as a hub on the Linux server | 0.5 day |
| PR 1 `feat: let your other machines reach this Tars` | Tasks 1 to 8 | Settings > Machines: serve, code, knock and Accept (see or drive), reach a hub, statuses, Forget | 2 to 2.5 days |
| PR 2 `feat: see the agents of a Tars you reach` | Tasks 9 to 12 | the hub's agents in Dashboard and Agents, badge, filter, offline line, live read-only terminal | 2 days |
| PR 3 `feat: drive the agents of a Tars that lets you` | Tasks 13 to 16 | start, stop with a reason, message, typing, size follows the pane | 1.5 to 2 days |
| (real test, no PR) | Task 17 | hub on the server, Mac and PC as spokes, checklist passed with Nicolas | 0.5 to 1 day |
| | | **Total** | **6.5 to 8 days** |

If Noah wants smaller PRs, PR 1 splits at the IPC line: 1a the main process (Tasks 1 to 6, units only) and 1b the section and its E2E (Tasks 7 and 8).

## Security review gate

Critical lane, for each PR, in this order:
1. Self-check against the Global Constraints and SECURITY.md §2 and §5, written into the PR description: every new route with who it admits, every new file with where it lives and its mode.
2. One fresh security reviewer (a single subagent on the most capable model, not a swarm) reads the PR's diff against this threat list: exposure beyond the tailnet; a route reachable without the spoke's secret; a secret or hash reaching the window, a log or a CLI; Drive enforced anywhere but the hub, or read before the body is in; text typed into a PTY without the sanitising every message gets (paste end, look-alike sender lines); resource exhaustion (body size, streams per machine, slow readers, poll pile-up); remote strings rendered with controls or format characters; a remote id resolved by local IPC. Blocking findings are fixed and the reviewer reads again until it finds none; nits go to the PR's follow-up list.
3. The full gate once per PR, not per commit: both `tsc`, `npm test`, `npm run lint`, `npm run lint:design`, `npm run check:names`, `npm run check:dashes`, `npm run e2e:guard`, `npm run e2e:auto`, the PR's own spec with its artefact and its mutant.
4. After PR 3, one whole-feature security review of the three PRs together, then Task 17 on the real machines.
5. Nothing leaves the fork without Nicolas's explicit go for that exact action.

## Decisions before PR 1 (Nicolas's)

1. **The hub's premise (Task 0).** Tars has never run on Linux beyond its unit tests; a half-day spike on the server (packages and a service beside Hermes) proves it or stops the plan. Recommended: go.
2. **Where the hub's Accept is clicked.** Recommended for step 2: in the hub's own window, reached over the tailnet by a remote screen (no new code, nothing new to review). The alternative, a pairing command over SSH, is new code and a new local credential, for a later PR.
3. **What Accept gives.** Recommended: the hub's request card asks it ("Let it see" or "Let it see and drive"), no default, one click either way. Alternatives: Drive by default (the fork's choice of 2026-10-09) or See by default with Drive as a later switch.
4. **The Tailscale ACL.** Port 31418 to the server must be added to the tailnet's rules by Nicolas in the admin console (and ufw on `tailscale0` on the server); nothing else on the tailnet should reach it.
5. **Telling Noah first.** A listener on the network is a boundary the maintainer owns: recommended, an issue with the SECURITY §8 draft before PR 1 is opened, on Nicolas's go only.
6. **The frames.** The redrawn `Settings · Machines` in two halves, before any TSX.

Assumption: this worktree was made with `git worktree add` from `upstream/main` (Nicolas's instruction), not `scripts/worktree.mjs`, which refuses while the fork's main checkout is off `main`.

---

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `electron/services/tailscale-status.ts` (new) | this machine's tailnet address and name, its online peers, the device at an address | 1 |
| `electron/handlers/hermes-handlers.ts` | imports `detectTailscale` instead of keeping it | 1 |
| `electron/services/machines/types.ts` (new) | `MachinesFile`, `Spoke`, `Hub`, `MachinesView`, `PeerPermission`, `RemoteAgent`, `FleetAnswer`, `DriveRequest`, `DriveOutcome` | 1, grows in 2 and 3 |
| `electron/services/machines/store.ts` (new) | read, normalise, write `machines.json`; mint, hash, compare secrets; clean names | 1 |
| `electron/services/machines/pairing.ts` (new) | the offer, its proof and answer; pure, clock injected | 1 |
| `electron/services/machines/bridge-server.ts` (new) | bind, admit, the allow-listed routes | 1, grows in 2 and 3 |
| `electron/services/machines/client.ts` (new) | the spoke's calls to a hub | 1, grows in 2 and 3 |
| `electron/services/machines/status.ts` (new) | each hub: connected, offline, forgotten | 1 |
| `electron/services/machines/fleet-share.ts` (new) | an agent as a spoke may see it, field by field | 2 |
| `electron/services/machines/fleet-source.ts` (new) | the hub's fleet, screens and outputs for the bridge | 2 |
| `electron/services/machines/remote-fleet.ts` (new) | the spoke's poller, its checks, the remote ids | 2 |
| `electron/services/machines/drive.ts` (new) | `executeDrive`: start, stop, message, keys, size on a local agent for a named caller | 3 |
| `electron/core/pty-manager.ts` | `MessageSender` gains `{ kind: 'machine'; name: string }` and its sender line | 3 |
| `electron/services/task-ledger.ts` | `handOffFrom` maps it to the source `machine` | 3 |
| `electron/resources/agent-instructions.md` | what a `Message from the machine "<name>"` line is | 3 |
| `electron/handlers/machines-handlers.ts` (new) | IPC and the `machines:*` events | 1, grows in 2 and 3 |
| `electron/preload.ts`, `src/types/electron.d.ts` | `window.electronAPI.machines`, in one commit | 1, 2, 3 |
| `electron/main.ts` | register the handlers, start the bridge while serving, stop it in the quit's first pass | 1 |
| `src/lib/machines.ts` (new) | status sentences, "seen 2 min ago", merge of local and remote agents, the machine filter | 1, 2 |
| `src/hooks/useMachines.ts` (new) | the view and the remote fleet, kept current from events | 1, 2 |
| `src/components/Settings/MachinesSection.tsx` (new) | the section as drawn | 1 |
| `src/components/Settings/constants.ts`, `types.ts`, `src/app/settings/page.tsx` | the `machines` section and its header action | 1 |
| `src/components/ui/MachineBadge.tsx` (new) | the badge on another machine's items | 2 |
| `src/components/MachineStopReason.tsx` (new) | the one-line reason a remote stop needs | 3 |
| Dashboard and Agents page files (Task 11 names them) | remote agents merged, filter, offline line, remote pane | 2, 3 |
| `design/tars-redesign.pen`, `design/UI-INVENTORY.md`, `e2e/surfaces.mjs` | frames and the surface `settings-machines` | 1, 2, 3 |
| `e2e/ports.mjs` | the bridge's port moved by `E2E_PORT_OFFSET` | 1 |
| `e2e/machines-pairing.spec.ts`, `e2e/machines-see.spec.ts`, `e2e/machines-drive.spec.ts` (new) | one hub and one spoke on one machine | 1, 2, 3 |
| `SECURITY.md` §8, `SPECS.md`, `OPERATIONS.md`, `README.md`, `DESIGN.md` | what the bridge is and is not; how to run a hub | 1, 2, 3 |

---

### Task 0: A hub on the Linux server (spike, timebox half a day)

Not a PR. Proves the premise of the whole project before PR 1: upstream Tars has never run on Linux beyond `npm test` (no Linux build in `package.json`, no Linux E2E in `.github/workflows`), and a hub is Electron 24/7 on a 2 vCPU / 8 GB server that also runs Hermes. Needs Nicolas's go: it installs packages and a service on that server.

- [ ] **Step 1:** on the server, as a dedicated user, check out `upstream/main`, `npm ci`, both `tsc`, `npm run build` (renderer), start the app under `xvfb-run` with `NODE_ENV=production`. Expected: the window loads (screenshot through `xwd` or the VNC of Step 3), an agent with the fake CLI starts in a PTY, `better-sqlite3` and `node-pty` load.
- [ ] **Step 2:** measure: resident memory of Tars idle and with 3 agents, beside Hermes; `tailscale status --json` readable by that user without root.
- [ ] **Step 3:** reach the hub's window from a laptop over the tailnet only (x11vnc bound to the tailnet address, ufw on `tailscale0`), since Settings > Machines on the hub is where the code and the Accept are.
- [ ] **Step 4:** write the measured recipe (systemd unit, Xvfb, VNC, ufw, the Tailscale ACL line for port 31418) into a note for OPERATIONS.md (Task 8). Stop and report to Nicolas if Electron cannot run there reliably: the rest of this plan then needs another hub shape.

---

### Task 1: Tailscale status, shared (PR 1)

**Files:**
- Create: `electron/services/tailscale-status.ts`
- Modify: `electron/handlers/hermes-handlers.ts:257-306` (remove `TailscaleInfo`, `tailscalePlaces`, `detectTailscale`; import them; `tailscaleCandidates` stays in `platform/integration-paths.ts:44`)
- Test: `__tests__/electron/services/tailscale-status.test.ts`

**Interfaces:**
- Produces:
  - `export interface TailscalePeer { name: string; dnsName?: string; ip: string; online: boolean; sharee: boolean }`
  - `export interface TailscaleInfo { installed: boolean; running: boolean; dnsName?: string; ip?: string; serveConfigured: boolean; peers: TailscalePeer[] }` (the Hermes shape plus `peers`)
  - `export function parseTailscaleStatus(json: unknown): Pick<TailscaleInfo, 'running' | 'dnsName' | 'ip' | 'peers'>`
  - `export async function detectTailscale(): Promise<TailscaleInfo>`
  - `export async function deviceAt(address: string): Promise<string | undefined>` (the MagicDNS name of the peer at that IPv4)

- [ ] **Step 1: Write the failing test.** Header lists the ways it fails: an offline peer offered; an IPv6-only peer yielding an address the bridge cannot reach; the trailing dot kept on a MagicDNS name; an unexpected shape throwing instead of "not running"; this machine (Self) listed among its peers; a peer another tailnet shares in (`ShareeNode`) offered for pairing. Tests: `parseTailscaleStatus` on a fixture with Self, two online peers, one offline, one IPv6-only, one sharee returns exactly the two online IPv4 peers with `sharee: false`, names without trailing dot; on `null` and on `{}` returns `{ running: false, peers: [] }`.
- [ ] **Step 2:** `npx vitest run __tests__/electron/services/tailscale-status.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** move the code, add `parseTailscaleStatus` and `deviceAt` (one `status --json` call, no concurrent second one: the fork's "view() spawns tailscale twice" minor).
- [ ] **Step 4:** the test passes; `npx vitest run __tests__/electron/handlers/hermes-tailscale-choice.test.ts` still passes; `settings-hermes` surface unchanged.
- [ ] **Step 5:** commit `chore: share the tailscale status between hermes and machines`.

### Task 2: The pairing file (PR 1)

**Files:**
- Create: `electron/services/machines/types.ts`, `electron/services/machines/store.ts`
- Test: `__tests__/electron/machines/store.test.ts`

**Interfaces:**
- Produces:
  - `export type PeerPermission = 'see' | 'drive'`
  - `export interface MachineSelf { id: string; name: string }` (id: 16 random bytes, base64url, minted once)
  - `export interface Spoke { id: string; name: string; device: string; address: string; secretHash: string; may: PeerPermission; pairedAt: string; lastSeenAt?: string }`
  - `export interface Hub { id: string; name: string; address: string; port: number; secret: string; pairedAt: string }`
  - `export interface MachinesFile { version: 1; self: MachineSelf; serve: boolean; spokes: Spoke[]; hubs: Hub[] }`
  - `readMachines(): MachinesFile`, `writeMachines(file: MachinesFile): void`, `newSecret(): string`, `hashSecret(secret: string): string`, `secretMatches(secret: string, hash: string): boolean`, `isSecret(value: unknown): value is string`, `cleanName(raw: unknown): string | undefined`

- [ ] **Step 1: Write the failing test.** Header: a missing file read as an error; a file written world-readable; a corrupt file overwritten by a fresh one (it must be kept as `machines.json.corrupt`, ETHOS §7); a spoke with a malformed hash or permission kept; `serve` read as true from anything but `true`; a comparison that leaks timing or throws on lengths that differ; a name with a newline, a control or more than 40 characters kept as is. Tests assert each, including `secretMatches('x', hashSecret('y')) === false` without a throw and that a `may` other than `'see'`/`'drive'` reads as `'see'`.
- [ ] **Step 2:** run it: FAIL.
- [ ] **Step 3:** implement; port `cleanName`, `newSecret`, `hashSecret`, `secretMatches` from `origin/win/machines:electron/services/machines/store.ts`.
- [ ] **Step 4:** run it: PASS.
- [ ] **Step 5:** commit `feat: keep paired machines in the private folder`.

### Task 3: The pairing offer and its proof (PR 1)

**Files:**
- Create: `electron/services/machines/pairing.ts` (port of `origin/win/machines:electron/services/machines/pairing.ts`, unchanged in substance)
- Test: `__tests__/electron/machines/pairing.test.ts` (port, failure header kept)

**Interfaces:**
- Produces: `export interface Offer { code: string; nonce: string; expiresAt: number; attempts: number; closed: boolean }`, `openOffer(now: number): Offer`, `keyFor(code: string, nonce: string, callerNonce: string): Buffer` (scrypt, N 2^15, r 8, p 1, 32 bytes), `proofOf(key: Buffer, nonce: string, callerNonce: string, callerId: string): string`, `checkProof(offer: Offer, proof: string, callerNonce: string, callerId: string, selfId: string, now: number): 'ok' | 'wrong' | 'expired' | 'spent' | 'self'`, `answerOf(key: Buffer, nonce: string, callerNonce: string, callerId: string, selfId: string): string`, `isNonce(value: unknown): value is string`

- [ ] **Step 1:** port the tests: expiry decided by the offer's clock alone (5 min); the sixth proof after five wrong is `spent`; a second success is `spent`; `callerId === selfId` is `self`; a proof made with another caller nonce is `wrong`; the code never appears in `proofOf`'s output.
- [ ] **Step 2:** FAIL. **Step 3:** port. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: prove a pairing code without sending it`.

### Task 4: The bridge on the hub: bind, admit, pair (PR 1)

**Files:**
- Create: `electron/services/machines/bridge-server.ts`
- Test: `__tests__/electron/machines/bridge-server.test.ts`, `__tests__/electron/machines/bridge-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 `detectTailscale`, `deviceAt`; Task 2 store; Task 3 pairing.
- Produces:
  - `export const MACHINES_PORT_DEFAULT = 31418`
  - `export interface BridgeDeps { onChanged(): void; onRequestChanged(): void; deviceAt(address: string): Promise<string | undefined>; pairWaitMs?: number; now?(): number }` (PR 2 adds `fleet`, `screenOf`, `onOutput`; PR 3 adds `drive`)
  - `export function resolveBindTarget(env: NodeJS.ProcessEnv, packaged: boolean, tailnetIp: string | undefined): { host: string; port: number } | { reason: string }`
  - `export function isTailnetAddress(address: string | undefined): boolean`
  - `export function startBridge(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string }>`, `stopBridge(): Promise<void>`
  - `export function openPairingOffer(): Offer`, `closePairingOffer(): void`, `currentOffer(): Offer | null`
  - `export interface PairRequest { name: string; device?: string; address: string; expiresAt: number }`, `currentRequest(): PairRequest | null`, `decidePairRequest(decision: 'refuse' | PeerPermission): boolean`
  - Routes: `GET /machines/v1/hello` (`{ id, name, nonce }` while a code is shown, else 404), `POST /machines/v1/knock` (`{ id, name, nonce }`: held up to `pairWaitMs` = 60 s for the decision), `POST /machines/v1/pair` (`{ id, callerNonce, proof }` from the accepted address within 30 s: answers `{ id, name, answer, secret }`), `GET /machines/v1/ping` (`{ id, name }`), `POST /machines/v1/unpair`.

- [ ] **Step 1: Write the failing tests.** Header: listening on `0.0.0.0` or `::`; listening with no tailnet address; a dev variable read by a packaged build; a caller outside `100.64.0.0/10` admitted; an unknown path answering anything but 404, or reading the credential first; a request with `Origin` admitted; a 65 KB body read; a knock accepted with no code shown or while another waits; a pair from another address than the knock's, or after 30 s, or from a refused knock; the decision's permission not stored on the spoke's row; `ping` without the secret answering anything but 401; the shared API token or the bridge token admitted. One `it` per line, against a real `http` server on `127.0.0.1` with `tailnetOnly: false` for the address cases that need it, plus `rebinds once the tailnet address returns` with `detectTailscale` stubbed to no address then an address.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** port `handleBridgeRequest`, `resolveBindTarget`, `isTailnetAddress`, the offer and request state from the fork's file, keeping only the five routes above; `decidePairRequest` takes the permission and the pair handler writes it on the new `Spoke`; the hub issues the only secret.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: serve pairing on the tailnet address only`.

### Task 5: The spoke's side: reach a hub, know its state (PR 1)

**Files:**
- Create: `electron/services/machines/client.ts`, `electron/services/machines/status.ts`
- Test: `__tests__/electron/machines/client.test.ts`, `__tests__/electron/machines/status.test.ts`

**Interfaces:**
- Consumes: Task 3 `keyFor`, `proofOf`, `answerOf`; Task 4 routes.
- Produces:
  - `export interface Candidate { id: string; name: string; device: string; address: string; port: number }`
  - `findCandidates(peers: TailscalePeer[], port: number): Promise<Candidate[]>` (asks `hello` of each online non-sharee peer, 2 s each, in parallel)
  - `connect(candidate: Candidate, code: string): Promise<{ ok: true; hub: Hub } | { ok: false; error: string }>` (knock, wait up to 75 s, prove, check the answer within 5 s)
  - `ping(hub: Hub): Promise<'connected' | 'offline' | 'forgotten'>`, `unpair(hub: Hub): Promise<void>`
  - `export type HubStatus = 'connected' | 'offline' | 'forgotten' | 'unknown'`; `watchHubs(onChange: () => void): () => void` (every 15 s while PR 2's fleet poll is absent; replaced by it in Task 10)

- [ ] **Step 1: Write the failing tests.** Header: the code sent in clear; an answer accepted whose proof is wrong, whose id differs from `hello`'s, whose name is not a clean name, or whose secret is not 43 characters; a wait longer than 75 s or 5 s; a 401 read as offline (`401 reads as forgotten`); a network error read as forgotten; two pings to one hub in flight; "No Tars on your tailnet shows a pairing code" without the hint about Tailscale access rules when peers exist but none answers.
- [ ] **Step 2:** FAIL. **Step 3:** port from `origin/win/machines:electron/services/machines/client.ts` and `status.ts`, spoke side only. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: reach a Tars that serves you`.

### Task 6: IPC, preload and the app's lifecycle (PR 1)

**Files:**
- Create: `electron/handlers/machines-handlers.ts`
- Modify: `electron/preload.ts:37` (a `machines` namespace), `src/types/electron.d.ts:1310` (`machines?:` on `ElectronAPI`, same commit), `electron/main.ts` (`registerMachinesHandlers` beside the others at 660-723; start the bridge while serving; `stopBridge` as a step of `runShutdownSteps` at 1021-1063), `e2e/ports.mjs` (`bridgePort(base)`)
- Test: `__tests__/electron/handlers/machines-handlers.test.ts`

**Interfaces:**
- Produces, on `window.electronAPI.machines`:
  - `view(): Promise<MachinesView>` where `MachinesView = { self: MachineSelf & { address?: string }; tailscale: { installed: boolean; running: boolean }; serve: { on: boolean; listening: boolean; reason?: string }; offer: { code: string; expiresAt: string } | null; request: { name: string; device?: string; address: string; expiresAt: string } | null; spokes: Array<{ id: string; name: string; device: string; may: PeerPermission; lastSeenAt?: string }>; hubs: Array<{ id: string; name: string; status: HubStatus; lastSeenAt?: string }> }`
  - `setServe(on: boolean)`, `setName(name: string)`, `openOffer()`, `closeOffer()`, `decide(decision: 'refuse' | 'see' | 'drive')`, `candidates(): Promise<Candidate[]>`, `connect(address: string, code: string)`, `setPermission(spokeId: string, may: PeerPermission)`, `forget(id: string)`, each returning the new `MachinesView` or `{ error: string }`
  - `onChanged(listener: (view: MachinesView) => void): () => void` (event `machines:changed`)

- [ ] **Step 1: Write the failing tests.** Header: a secret or a hash in any view; `decide` taking anything but the three words; `connect` to an address that is no current candidate; `setPermission` on an unknown spoke creating one; `forget` of a hub leaving its secret in the file; `setServe(true)` with no tailnet address claiming to listen.
- [ ] **Step 2:** FAIL. **Step 3:** implement (Task 9 adds the `closeStreamsOf` call to a spoke's `forget`); `forget` of a hub calls `unpair` first, then removes it whatever the answer. **Step 4:** PASS; both `tsc` clean.
- [ ] **Step 5:** commit `feat: machines in the main process, behind the preload`.

### Task 7: Settings > Machines and the pairing E2E (PR 1)

**Files:**
- Modify: `design/tars-redesign.pen` (through `pen interactive`), `design/UI-INVENTORY.md`, `e2e/surfaces.mjs` (`SETTINGS_TREE`), `e2e/fixture.mjs` (the seeded home gets a `machines.json` with a fixed self, id and name `Sandbox`, so the reference screenshot never shows a random id or the host's name; `writeFakeTailscale` at 615-637 answers "no tailnet" for the surface sweep)
- Create: `src/lib/machines.ts`, `src/hooks/useMachines.ts`, `src/components/Settings/MachinesSection.tsx`, `e2e/machines-pairing.spec.ts`
- Modify: `src/components/Settings/constants.ts:42` (a leaf `machines` in `SECTION_GROUPS`, in the group that holds Hermes, icon `Monitor`), `src/components/Settings/types.ts:172` (`'machines'` merged into the current `SettingsSection` union, not the fork's older one), `src/components/Settings/index.ts` (the export), `src/app/settings/page.tsx` (the `case` at 129-241 and the required `HEADER_ACTIONS` entry at 53, "add a machine")
- Test: `__tests__/lib/machines.test.ts`

**Interfaces:**
- Consumes: Task 6's API.
- Produces: `statusSentence(hub: MachinesView['hubs'][number], now: number): string` ("Connected", "Offline since 14:02", "Forgotten by <name>"), `seenAgo(iso: string | undefined, now: number): string`, `useMachines(): { view: MachinesView | null; busy: string | null; run(action: () => Promise<unknown>, label: string): Promise<void> }`

- [ ] **Step 1: Frames.** Redraw `Settings · Machines` in two halves ("This Tars": name, serve switch with its address or reason, code, the request card with Refuse / Let it see / Let it see and drive, the machines that reach it with See/Drive and Forget; "Tars this one reaches": Reach another Tars, each hub's row and Forget), and the two pairing frames ("A machine asks to reach this Tars", "Waiting for the other Tars"), copying the validated fork frames' parts. Export PNGs; Nicolas validates them before Step 3.
- [ ] **Step 2: Write the failing E2E.** `e2e/machines-pairing.spec.ts`, two `launchSandboxed` apps, each with its own HOME and API port; the hub with `TARS_MACHINES_BIND=127.0.0.1`, `TARS_MACHINES_PORT=bridgePort(31418)`, the spoke with `TARS_MACHINES_PEERS=127.0.0.1:<that port>`. Asserts: neither Tars listens before Serve (a connect to the port is refused); the hub turns Serve on and shows a code; the spoke's Reach another Tars lists the hub; the spoke types the code; the hub shows the request naming the spoke's device and address before any secret exists in either file; the hub clicks "Let it see"; the spoke's row reads Connected, the hub's row shows the spoke with See; the hub's Forget makes the spoke's row read "Forgotten by <hub>". Saves the run directory (trace, screenshots of both windows, `asserted.json`). Unit tests for `statusSentence` and `seenAgo` written before them too.
- [ ] **Step 3:** implement the lib, the hook (busy state on every button: the fork's "the button does nothing" finding) and the section from the frames.
- [ ] **Step 4:** `npx tsc --noEmit`, `npx tsc -p electron/tsconfig.json`, `npx playwright test e2e/machines-pairing.spec.ts`: PASS. **Show it bites:** a mutant where `/knock` decides `see` by itself (no request shown) turns the spec red at "the hub shows the request"; record the red run's directory.
- [ ] **Step 5:** `npm run e2e:guard`, then `npx playwright test --update-snapshots -g settings-machines` for the one new reference.
- [ ] **Step 6:** commit `feat: pair a machine from settings`.

### Task 8: PR 1 closure: docs, changelog, review (PR 1)

**Files:**
- Modify: `SECURITY.md` (new §8 "Machines: a Tars that serves, and the Tars that reach it", from the fork's §8, rewritten one-way: what listens, the five routes, who is admitted, what pairing proves, who decides, what is left, what Drive gives away), `SPECS.md` (§10 surfaces, §11 security model, §13 limitations: a Windows hub needs its own firewall rule, which Tars does not add), `OPERATIONS.md` (Serving this Tars to your other machines: the Tailscale ACL line for port 31418, ufw on `tailscale0`, the Windows rule `-Profile Any -InterfaceAlias Tailscale -Protocol TCP -LocalPort 31418 -RemoteAddress 100.64.0.0/10`, the Linux hub recipe from Task 0), `README.md`, `src/data/changelog.ts`, `package.json`

- [ ] **Step 1:** write the docs; `npm run check:dashes`, `npm run check:names`.
- [ ] **Step 2:** the full gate (Security review gate, item 3). Expected: all clean, the spec's artefact saved.
- [ ] **Step 3:** the security review (gate items 1 and 2) until no blocking finding.
- [ ] **Step 4:** commit `docs: what serving this Tars opens, and how to run a hub`; push the PR 1 branch to `origin` only.

---

### Task 9: The hub's fleet, screens and live output (PR 2)

**Files:**
- Create: `electron/services/machines/fleet-share.ts`, `electron/services/machines/fleet-source.ts`
- Modify: `electron/services/machines/bridge-server.ts`, `electron/services/machines/types.ts`, `electron/handlers/machines-handlers.ts` (a spoke's `forget` calls `closeStreamsOf`), `electron/core/agent-manager.ts` (upstream has no output listener: add `onAgentOutput`, fed at the one place a terminal's data is broadcast as `agent:output`, `attachAgentTerminal` near line 1339)
- Test: `__tests__/electron/machines/fleet-share.test.ts`, `__tests__/electron/machines/bridge-fleet.test.ts`, `__tests__/electron/core/agent-output-listeners.test.ts`

**Interfaces:**
- Consumes: `agents` (`core/agent-manager.ts`), `ptyProcesses` (`core/pty-manager.ts`), `terminalSnapshot` (`core/terminal-mirror.ts:209`, what `agent:get` replays at `ipc-handlers.ts:1028`), `cliRunningIn` (`core/agent-pty.ts:300`), `withSessionTruth` (`services/agent-truth.ts:517`).
- Produces:
  - `export function onAgentOutput(listener: (agentId: string, chunk: string) => void): () => void` in `core/agent-manager.ts` (a listener that throws is logged and kept from the others; the returned function removes it)
  - `export interface SharedAgent { agentId: string; name: string; character?: string; provider?: string; model?: string; status: string; currentTask?: string; branch?: string; projectName: string; projectPath: string; cliRunning: boolean; lastActivity?: string; stoppedBy?: string; stopReason?: string; cols?: number; rows?: number }`
  - `export interface FleetAnswer { v: 1; machines: Array<{ id: string; name: string; youMay: PeerPermission; agents: SharedAgent[] }> }`
  - `shareAgent(agent: AgentStatus, size?: { cols: number; rows: number }): SharedAgent`, `fleetSource(): Pick<BridgeDeps, 'fleet' | 'screenOf' | 'onOutput'>`
  - Routes: `GET /machines/v1/fleet`, `GET /machines/v1/machines/:machineId/agents/:agentId/screen` (`{ screen, cliRunning, cols, rows }`), `GET .../stream` (SSE `data:` chunks, `event: end`); `closeStreamsOf(spokeId: string): void`; `MAX_STREAMS_PER_MACHINE = 32`

- [ ] **Step 1: Write the failing tests.** Header (from the fork's §8 "What See shows"): a token, env, CLI path, worktree, second project, session id, skills, permission mode or asker in a shared agent; an unbounded string; a fleet without `youMay`; an agent route with another `machineId` answering anything but 404; an agent route answering differently for an unknown agent than for a known one without the secret (401 both); a 33rd stream from one spoke; a reader 4 MB behind kept open; a stream kept after its spoke is forgotten (`forget cuts that spoke's streams at once`) or after the 15 s re-check finds its pairing gone.
- [ ] **Step 2:** FAIL. **Step 3:** port the fork's `fleet-share.ts` and the read half of `fleet-source.ts`; the fleet wraps the hub's agents in `machines: [{ id: self.id, name: self.name, youMay: spoke.may, agents }]`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: a hub shares its agents with the machines it lets see`.

### Task 10: The spoke's remote fleet (PR 2)

**Files:**
- Create: `electron/services/machines/remote-fleet.ts`
- Modify: `electron/services/machines/client.ts` (`fetchFleet`, `fetchScreen`, `openStream`), `electron/handlers/machines-handlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts`, `electron/services/machines/status.ts` (the fleet poll replaces the ping)
- Test: `__tests__/electron/machines/remote-fleet.test.ts`, `__tests__/electron/machines/client-stream.test.ts`

**Interfaces:**
- Produces:
  - `export interface RemoteAgent extends SharedAgent { id: string /* m:<machineId>:<agentId> */; machine: { id: string; name: string; via: string; status: HubStatus; offlineSince?: string; youMay: PeerPermission } }`
  - `readFleet(raw: unknown, hub: Hub): RemoteAgent[] | null` (512 KB, 200 agents, every field re-checked; a screen at most 8 MB, an event at most 1 MB)
  - `parseRemoteId(id: string): { machineId: string; agentId: string } | null`
  - `startRemoteFleet(onChange: (agents: RemoteAgent[]) => void): () => void` (every 3 s per hub, one request in flight at most)
  - IPC: `machines.agents(): Promise<RemoteAgent[]>`, `onFleet(listener)`, `screen(remoteId)`, `watch(remoteId)`, `unwatch(remoteId)`, `onOutput(listener: (e: { remoteId: string; chunk: string }) => void)`, `onOutputEnd(listener)`

- [ ] **Step 1: Write the failing tests.** Header: `one fleet request in flight at most` when a poll outlasts 3 s; an offline hub's agents dropped instead of kept with `offlineSince`; a remote id colliding with a local id (never without the `m:` prefix); a 513 KB fleet or a 201st agent accepted; a stream silent 45 s kept; `reattaches a watched pane once after offline`; watches leaking past a window reload (released on the sender's `destroyed` and `did-navigate`).
- [ ] **Step 2:** FAIL. **Step 3:** port `remote-fleet.ts` and the stream client; key agents by origin machine and keep `via`. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: a spoke keeps the fleet of the hubs it reaches`.

### Task 11: Remote agents in Dashboard and Agents, and the see E2E (PR 2)

**Files:**
- Modify: `design/tars-redesign.pen` (frames `Dashboard · two machines`, `Panel · machine offline`, `Agents · two machines`, ported from the fork's design branch), `DESIGN.md` (the badge and its `--machine-ink` token), `src/app/globals.css` (the token, light and dark)
- Create: `src/components/ui/MachineBadge.tsx`, `src/hooks/useRemoteAgents.ts` (port), `e2e/machines-see.spec.ts`
- Modify: `src/lib/machines.ts` (`mergeAgents`, `machineFilterOptions`, `offlineLine`); wiring only in the Dashboard (`src/components/TerminalsView/index.tsx:56`, where `useElectronAgents` from `src/hooks/useElectron.ts:18` feeds the grid; `hooks/useMultiTerminal.ts`: `initTerminal` at 117 replays `machines.screen` for a remote id where it replays `agent.get` at 219, the output subscription at 484 takes `machines.onOutput` for remote ids, `safeFit` at 41-51 sends no `agent.resize` for one; `TerminalPanel.tsx`, `TerminalPanelHeader.tsx`, `Sidebar.tsx`) and the Agents page (`src/app/agents/page.tsx:52`, `src/components/AgentList/AgentManagementCard.tsx`)
- Test: `__tests__/lib/machines-remote.test.ts`

**Interfaces:**
- Consumes: Task 10's IPC.
- Produces: `mergeAgents<T extends { id: string }>(local: T[], remote: RemoteAgent[]): Array<T | RemoteAgent>` (local first, then each machine's by name), `isRemote(agent: { id: string }): boolean`, `machineFilterOptions(remote: RemoteAgent[]): Array<{ id: string; label: string }>` ("This Tars", then each machine), `offlineLine(machine: RemoteAgent['machine'], now: number): string`; `<MachineBadge name={string} offline={boolean} />` (only on another machine's items, never on local ones).

- [ ] **Step 1:** frames, validated by Nicolas.
- [ ] **Step 2: Write the failing E2E.** `e2e/machines-see.spec.ts`: hub and spoke paired with See through the API of Task 6; the hub runs an agent on the recording fake CLI that prints a marker every second. Asserts: the agent appears on the spoke's Dashboard and Agents page with the hub's badge; its pane shows the marker live; the machine filter "This Tars" hides it and the hub's name shows it alone; the pane offers no input (See); quitting the hub shows the offline line within 10 s and keeps the card; restarting it brings the marker back in the same pane (not a second one); a local agent carries no badge. Units for the four lib functions first.
- [ ] **Step 3:** implement; a See-only remote pane scales the remote terminal's `cols`/`rows` to fit (the fork's fix for full-screen CLIs, bfcd0fa4).
- [ ] **Step 4:** the spec passes. **Show it bites:** a mutant where `mergeAgents` drops remote agents whose hub is offline turns it red at "keeps the card"; record it.
- [ ] **Step 5:** commit `feat: see the agents of a Tars you reach`.

### Task 12: PR 2 closure (PR 2)

- [ ] **Step 1:** SECURITY.md §8 gains "What See shows" (the terminal travels as it is, secrets a CLI echoes included; holding fields out of the fleet is no boundary for the screen); SPECS, README, changelog.
- [ ] **Step 2:** full gate; **Step 3:** security review until clean; **Step 4:** commit `docs: what a hub shows the machines it lets see`, push the PR 2 branch to `origin` only.

---

### Task 13: The drive executor and the machine's sender line (PR 3)

**Files:**
- Create: `electron/services/machines/drive.ts`
- Modify: `electron/core/pty-manager.ts:447-473` (`MessageSender` gains `{ kind: 'machine'; name: string }`; `senderLine` returns `Message from the machine ${envelopeValue(name)}: `), and every reader of that union (ETHOS §8, read the siblings): `services/task-ledger.ts:877` (`handOffFrom` maps it to `source: 'machine'`, `TaskSource` gains it), `services/chat-runners.ts:366` (`fromOf`), `api-routes/kanban-routes.ts:136`, `services/carry-over.ts:72`, `core/task-requests.ts:64-66`, `services/chat-transcript.ts:69` (`OTHER_ENVELOPE` must match the new line, or a machine's message reads as the user's own words in a transcript); `electron/resources/agent-instructions.md:55-57` and `super-agent-instructions.md:90` (the line hands work as Tars does, answers no question the agent asked the user, lifts no rule the user set)
- Test: `__tests__/electron/core/sender-line-machine.test.ts` (with a case per reader above, `chat-transcript` included), `__tests__/electron/machines/drive.test.ts`

**Interfaces:**
- Consumes: `launchAgent` (`core/agent-launch.ts:80`), `sessionStarting` (`:173`), `wakeAgent` (`core/agent-asleep.ts:137`), `stopAgent`, `noteRestartAfterStop` (`core/agent-stop.ts`), `writeProgrammaticInput` (`core/pty-manager.ts:1288`), `writeHumanInput` (`:686`), `resizeTerminalMirror` (`core/terminal-mirror.ts:179`), `rememberPanelSize` (`:520`), `broadcastToAllWindows`, `scheduleTick`.
- Produces:
  - `export type DriveRequest = { action: 'start'; agentId: string } | { action: 'stop'; agentId: string; reason: string } | { action: 'message'; agentId: string; text: string } | { action: 'keys'; agentId: string; data: string } | { action: 'size'; agentId: string; cols: number; rows: number }`
  - `export interface DriveCaller { name: string }` (the name the hub paired it under; step 5 adds Hermes as another caller)
  - `export type DriveOutcome = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string }`
  - `executeDrive(request: DriveRequest, caller: DriveCaller): Promise<DriveOutcome>`; `MAX_DRIVE_TEXT = 8000`, `MAX_KEYS = 4096`

- [ ] **Step 1: Write the failing tests.** Header: a start that types a first prompt; a stop without a reason, or with a reason of controls only; a stop or a start after a stop filed under anything but `<name> (machine)`; a message over 8,000 characters, or made of controls and format characters only; a message typed into a terminal whose CLI has ended; text carrying a paste end or a look-alike sender line typed raw; keys over 4,096 characters, or typed when the CLI is not running; a size outside whole numbers 1 to 1000; `size from a spoke does not echo a resize back` (the hub's own pane is told and does not answer with its own size until its next click or key); an unknown agent answering a sentence that differs from the one for an agent of another project (one 404 sentence, naming no agent).
- [ ] **Step 2:** FAIL. **Step 3:** port the drive half of `origin/win/machines:electron/services/machines/fleet-source.ts` into `executeDrive`, which takes the request and the caller and nothing about HTTP. It follows the window's own IPC path (`agent:stop` at `ipc-handlers.ts:1079` files `by: 'you'`, `agent:resize` at 1235), not the API's drive guards (`resolveDriver`, `mayStop` in `agent-routes.ts:811-894`): a machine with Drive stands for the user at another keyboard, not for an agent, and SECURITY.md §8 says so. A stop still needs its reason, as `/stop` does (`stopReasonOf`). **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: a machine's sender line and the drive executor`.

### Task 14: The drive routes and the spoke's calls (PR 3)

**Files:**
- Modify: `electron/services/machines/bridge-server.ts` (five `POST .../machines/:machineId/agents/:agentId/{start,stop,message,keys,size}` routes calling `executeDrive`), `electron/services/machines/client.ts` (`drive(hub, machineId, request)`), `electron/handlers/machines-handlers.ts`, `electron/preload.ts`, `src/types/electron.d.ts`
- Test: `__tests__/electron/machines/bridge-drive.test.ts`

**Interfaces:**
- Produces: IPC `machines.start(remoteId)`, `stop(remoteId, reason)`, `message(remoteId, text)`, `keys(remoteId, data)`, `size(remoteId, cols, rows)`, each `Promise<{ success: true } | { success: false; error: string }>`.

- [ ] **Step 1: Write the failing tests.** Header: a See spoke driving (403 with "<hub> lets <spoke> see only."); Drive taken back between the request's head and its body still driving; a spoke forgotten mid-request driving; a spoke's `youMay` from its own fleet trusted anywhere on the hub; a body over 64 KB read; an action on another `machineId` reaching a local agent.
- [ ] **Step 2:** FAIL. **Step 3:** port the fork's `driveAgent` route handler around `executeDrive`, re-reading the store before and after the body. **Step 4:** PASS.
- [ ] **Step 5:** commit `feat: drive a hub's agents where it allows it`.

### Task 15: Driving from the window, and the drive E2E (PR 3)

**Files:**
- Modify: `design/tars-redesign.pen` (the remote stop reason sheet, if the fork's frames lack it), the Dashboard's start and stop (`TerminalsView/components/ContextMenu.tsx:43`, `TerminalPanelHeader.tsx:216`, their handlers in `TerminalsView/index.tsx:388-446`: shown for a remote agent the hub lets drive, routed to `machines.start` and `machines.stop` with the reason; `src/lib/stop-line.ts:47` already renders "<by>: <reason>"), the remote pane in `hooks/useMultiTerminal.ts` (`keySender` at 205 goes to `machines.keys` through the queue, `safeFit` to `machines.size` for a Drive pane; a See pane keeps scaling)
- Create: `src/components/MachineStopReason.tsx`, `src/hooks/useRemoteDrive.ts` (port), `e2e/machines-drive.spec.ts`
- Modify: `src/lib/machines.ts` (`keyQueue(send: (data: string) => Promise<boolean>): { push(data: string): void; failed: boolean }`)
- Test: `__tests__/lib/machines-keys.test.ts`

- [ ] **Step 1: Write the failing tests.** Unit: `keys keep their order and stop at the first failure` (a queue whose second send fails sends the first, marks failed, never sends the third). E2E `e2e/machines-drive.spec.ts`: paired with Drive; the spoke starts the hub's stopped fake-CLI agent and the hub's card reads running; it types `hello` in the remote pane and the fake CLI's recorded input holds `hello`; it sends a message and the recorded input holds `Message from the machine "<spoke>": ` before it; the pane's size reaches the hub's terminal (the fake CLI records its `cols`); it stops the agent with the reason "done for today" and the hub's card reads stopped by "<spoke> (machine)" with that reason; the hub sets the spoke to See and the spoke's context menu offers no start, and a start through IPC is refused with the hub's sentence.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Show it bites:** a mutant where the route skips the second store read lets the See case drive; record the red run.
- [ ] **Step 5:** commit `feat: start, stop, message and type into a hub's agents`.

### Task 16: PR 3 closure and the whole-feature review (PR 3)

- [ ] **Step 1:** SECURITY.md §8 gains "What a machine may do here" and "What Drive gives away" (Drive to a machine is Drive to every process of its user there; keys are a person at this keyboard, a CLI's `!` a shell here), SPECS, README, changelog.
- [ ] **Step 2:** full gate; **Step 3:** security review until clean, then the whole-feature review of PRs 1 to 3 together; **Step 4:** commit `docs: what driving from another machine gives`, push the PR 3 branch to `origin` only.

### Task 17: The real test: the server as hub, Mac and PC as spokes

Not a PR. With Nicolas, from his machines, the fork's dev builds of the three PRs:

- [ ] Hub: Serve on; Settings shows the tailnet address; nothing listens on another address (`ss -ltnp` on the server).
- [ ] Mac and PC each pair (one with See, one with Drive); a device not in the ACL cannot reach port 31418.
- [ ] Each spoke shows the hub's agents with the badge; live terminal; Drive: start, stop with a reason, message, typing in a full-screen CLI, size follows the pane with many panes and full screen.
- [ ] The server restarts: both spokes show the offline line, then reconnect by themselves.
- [ ] A spoke is forgotten on the hub: it reads "Forgotten by <hub>".
- [ ] Write what was measured into the PRs' descriptions; deferred findings go to a follow-up list, not into these PRs.
