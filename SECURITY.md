# Security notes

What Tars defends against, what it does not, and which of the two a given
change is. Measured, dated, and written down when the measurement says a
defence is not one: a lid that reads like a boundary is worse than an open door
nobody mistook for closed.

Everything here was measured on Noah's machine, macOS 26.6.1 (Darwin 25.6.0),
on `main` at `b17db0f`, between the 17th and the 18th of September 2026, except
where a passage names `bad8c97`: the first version of the 1.7.6 work, which an
audit read on the 18th and found holes in.

---

## 1. The threat this app actually has

One user account. One person. Every agent Tars starts runs as that person, with
that person's shell, that person's keychain and that person's files. Nothing in
the API, in a file mode or in a `--add-dir` flag changes that, because none of
them is enforced against a process that simply opens the file.

So there are two different questions, and they are answered in two different
places:

- **Which agent is this, and may it do that?** A question about mistakes and
  about crossing wires: an orchestrator picking the wrong id out of a global
  listing, an MCP client that started without a token, a browser tab reaching
  `127.0.0.1`. This is answerable, and the local API answers it.
- **Can agent A obtain what agent B holds?** A question about isolation. On one
  user account, with no sandbox, the answer is yes, always, whatever the API
  does. It is not answerable by a check in a route.

Confusing the two is how a defence becomes theatre. The rest of this file keeps
them apart.

---

## 2. What the local API decides (and what it cannot)

Since the identity work of 1.7.x an agent is named by the token Tars minted for
its process, never by a header. Since 1.7.6 the routes that **drive** an agent
(start, dispatch, run-task, stop, message, delete, and create) refuse a caller
that is nobody, and the Hermes webhook, which drives one too, opens to Hermes
alone:

| Credential | Who it is | What it opens |
|---|---|---|
| An agent's token (`CLAUDE_MGR_API_TOKEN`, minted in memory per terminal and per ACP run) | that agent | its own project's agents, and a new agent in its own project, never an orchestrator (`POST /api/agents` refuses the role to every caller: only the Agents page makes one); another project's only with `allowCrossProject`. Not the webhook |
| Tars's own pass (minted in memory, written nowhere) | the main process | every agent of every project: it is Noah's super chat, which drives every project by design. Not the webhook |
| `~/.tars-private/hermes-webhook-secret` | Hermes | `POST /api/webhooks/hermes` and nothing else, and through it any agent of any project, named by id or by name |
| `~/.dorothy/api-token`, the shared token | nobody | reads, and the exempt routes. It drives no agent, and does not open the webhook |

Measured before the change, on `b17db0f`: a call presenting the shared token
with **no** `x-tars-client` header stopped, started, dispatched to and DELETEd
an agent of any project and got a `200`. The guard refused only a caller that
*volunteered* `x-tars-client: mcp`, which is a header the caller writes about
itself. Every agent can read that token file, so the fleet was open to any of
them; it could not simply be refused, because the super chat authenticated the
same way. It no longer does.

Measured again on `bad8c97`, the first version of that change, by the audit that
read it: the webhook still let the shared token drive the fleet. It took the
master token as a fallback, "so an existing setup keeps running"; with no secret
file it skipped its own check altogether, so an agent's own token went through
too; and it hands its target to `performDispatch`, which checks nothing, after
resolving it by name across every project. The shared token with a secret
configured, and the shared token or an agent's token with none, each got a
`200` and had the message typed into the agent it named, the agent's token into
another project's. The route now opens to the webhook secret and to nothing
else, and no secret configured means no way in. The same audit found creation
held to an identity but not to a project, while the table above already said
its own project: an agent created one in any project it named, with a `200`.
Creation now follows the rule the other routes follow.

**What this is.** A guard against mistakes, and against a *casual* reader of the
token file. It is not isolation: see §3.

**What it leaves open, deliberately.** The read routes (`GET /api/agents`, and
per-agent status, output, health, wait, bootstrap) still accept the shared
token. So a process holding that file can still enumerate the fleet and read any
agent's terminal output. The hooks no longer need it: since 2026-09-23 they
present the token of the CLI they run in, for the bootstrap and memory reads and
on `/api/hooks/*`, where nothing else is accepted (below). Closing the reads to
the shared token is now a change to routes only.

**What the hook routes take.** `/api/hooks/*` sets an agent's status and output and
registers the session that owns it, so until 2026-09-23 anybody on the loopback could
post for any agent with no credential: the Audit registered one agent's session for
another and got its conversation back through a restart (`--resume`), and a killed
CLI's late SessionStart took its agent from the live session by accident. The hooks
run inside the agent's CLI and inherit its `CLAUDE_MGR_API_TOKEN`, minted for that
terminal: a post now carries it, and the route takes nothing else (not the shared
token, not Tars's pass, not the token of a delegated ACP run, which names the agent
too) and only for the `agent_id` it names. The Audit's gate of #135 posted a
SessionStart with a run's token: it registered a session over the live terminal's,
which then had every post refused as stale. A terminal replaced by a restart or a new
start, or one that has ended, takes its token with it: the old CLI's late posts are a
401, where a stopped CLI's token used to last until the agent's next launch.
A hook sends that token only to the Tars that spawned its CLI (the Audit's table,
#11). While Tars is down any process of any account may hold its port, and got every
token posted to it: measured on 2026-09-24 with a listener on the port after the quit,
the 1.9.0 hook sent it `Bearer <the terminal's token>`. Tars now mints an instance id
per run (`tarsInstanceId`, in memory, never written) and hands it to each CLI beside the
token (`TARS_INSTANCE_ID`). As it starts, a hook sends a fresh random challenge to
`/api/health` and sends the token only when the answer is sha256 of the id and the
challenge; with no id, no answer within 5 s (longer than any post waits: a Tars whose main thread is held a few seconds still gets its token) or a wrong one, it posts without a token.
The same listener got the challenge and a post with no Authorization. The id is as
readable as the token by a process of the same user (`ps -Eww`), and no more: this
closes the port to other accounts and to a replay, not to that.
Upgrading from 1.7.9: quitting kills every agent terminal, so no CLI started by 1.7.9
outlives the update, and each is relaunched with a token and the new scripts (they sit
in the app bundle). One that survives anyway posts without a token, or with one this
Tars never minted, and is refused: stop and start it from Tars. The hook logs moved
from `/tmp` (readable by every user, shared by every Tars on the machine) to
`~/.dorothy/logs/`, `0600`, and Tars removes the two old files at startup
(`removeLegacyHookLogs`): only regular files the user owns, and only when `HOME` is the
user's own, so a sandbox never deletes the logs of a Tars still on 1.7.9 beside it.

**What the webhook secret is.** The reach of Noah's own chat, handed to Hermes,
so it lives where Noah's conversation lives, in `~/.tars-private`, and not in
`~/.dorothy`, where it was minted until 1.7.6. It moves at the first start that
finds it there, value unchanged, so a Hermes job that holds it keeps working.
That takes it out of the directory every agent is pointed at. It does not take
it out of an agent's reach: an agent that goes looking reads `~/.tars-private`
like any other file of Noah's (§1, §5), and with the secret drives any agent of
any project through the webhook. And an agent that read it before the move
still has it. Rotating it is deleting `~/.tars-private/hermes-webhook-secret`,
opening Settings > Hermes, which mints a new one, and giving Hermes that.

---

## 3. An agent's token is not secret from the other agents

`CLAUDE_MGR_API_TOKEN` travels to the CLI, and from the CLI to every MCP server
it starts, in the environment. The environment of a process is readable by any
other process of the same user.

Measured on 2026-09-18: six live `mcp-orchestrator` node processes on this
machine, every one of them exposing `CLAUDE_MGR_API_TOKEN` and
`CLAUDE_AGENT_ID` to `ps -Eww`. A canary in a `node` process is readable; the
same canary in `/bin/sleep` is not, because Apple's platform binaries hide
theirs and neither `claude` nor `node` is one.

Four parades were considered, and **none was written**:

| Parade | What it would do | Measured verdict |
|---|---|---|
| A `0600` file instead of the environment | | Moves it. Every agent runs as the same user, so `cat` reads it. `~/.dorothy/api-token` is already `0600` and is exactly the secret this replaced |
| An inherited file descriptor | Pass the token on an fd rather than in the environment | Not implementable. Tars starts the CLI through `node-pty`, whose `spawn` inherits the tty and nothing else, and the token has to reach the MCP servers, which the **CLI** starts, from its own environment. There is no fd route that does not go through Claude Code |
| A one-shot token exchanged at startup | Redeem the environment token once for a session token held in memory | Breaks the fleet. The same variable is what a respawned MCP server and the shell hooks present later; spending it on first use logs them out. And a sibling can read it before it is spent: a race, not a boundary |
| A unix socket per agent | Address the API through a per-agent socket | Moves it. The socket path is in the same environment, and filesystem permissions are per user, so any agent of that user connects. macOS has no abstract socket namespace |

And the sandbox, which is the one that sounds like it would work:

**It does not.** Measured under the strictest `sandbox-exec` profile in §4, a
five-line Python calling `sysctl KERN_PROCARGS2` still read another process's
environment. `(deny sysctl-read (sysctl-name "kern.procargs2"))` does not stop
it. `(deny process-info*)` does not stop it either, and kills the reader's own
interpreter, `git` and `npm` with it; `(deny process-info* (target others))`
leaves the toolchain alive and still does not stop it. What every profile does
stop is `/bin/ps`, which is setuid root and therefore cannot be executed under
any sandbox at all: the convenient route is closed, the syscall behind it is
not.

**The honest statement.** Per-agent tokens ended impersonation *by naming*: an
agent can no longer become a colleague by writing a header. They do not, and
cannot, end impersonation by a process that reads the process table. Closing
that needs agents in separate user accounts, or separate VMs. It is not a
line of TypeScript, and nothing in this repo pretends otherwise.

---

## 4. A sandbox for a Tars agent: what it would really buy

Noah decides this; nothing here is implemented, and no agent is confined by
anything Tars ships today. This is the measurement, so the decision has numbers
under it.

`claude` runs unconfined: its Bash reads everything Noah reads. `--add-dir` sets
**tool permissions**, not an access boundary, and on this machine 37 of the 42
agents in the fleet run with `--dangerously-skip-permissions`, where the flag
decides nothing at all.

### What was measured

A real `claude` (2.1.273), under `sandbox-exec`, on a disposable project, with a
disposable HOME and the login keychain reached by symlink. Its own report, in
full:

```
1. hello.txt - written successfully, contains `confined`.
2. git status --short - succeeded: `?? f.txt` and `?? hello.txt`
3. ls /Users/you/Documents - failed: ls: /Users/you/Documents: Operation not permitted
4. ps -Eww -p 39401 - failed: (eval):1: operation not permitted: ps
```

So: it did its work, and it could not read Noah's home. Separately measured
under the same profile: `~/.dorothy/api-token` denied, `/Users/you/tars`
denied, the loopback API reachable, `api.anthropic.com` reachable, `git`,
`node` and `npm` working.

### The profile that does it

This is the one the run above was made under, with `PROJECT` the agent's
working directory and `AGENTHOME` its HOME. It is not a proposal to adopt as
written: it is what it took to get a working agent, so that the cost is
visible.

```scheme
(version 1)
(deny default)

; --- what any program needs to start at all -------------------------------
(allow process-exec process-fork)
(allow file-map-executable)
(allow file-read-metadata)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-ioctl)

; --- the system, read only -------------------------------------------------
(allow file-read* (literal "/")
                  (subpath "/usr") (subpath "/bin") (subpath "/sbin")
                  (subpath "/System") (subpath "/Library") (subpath "/opt")
                  (subpath "/private/etc") (subpath "/private/var/db")
                  (subpath "/private/var/select") (subpath "/dev")
                  (subpath "/Applications"))
(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))

; --- the toolchain, wherever the user installed it -------------------------
; On this machine node, npm and claude itself all live under $HOME, so a
; profile that allows only /usr and /opt starts nothing.
(allow file-read* (subpath "/Users/you/.nvm")
                  (subpath "/Users/you/.local/bin")
                  (subpath "/Users/you/.local/share/claude")
                  (subpath "/Users/you/.config/git")
                  (literal "/Users/you/.gitconfig")
                  (literal "/Users/you/.gitignore_global")
                  (literal "/Users/you/.npmrc"))

; --- the credential store -------------------------------------------------
; Measured: without this the CLI answers "Not logged in · Please run /login".
; The OAuth token lives in the login keychain, so a profile that walls off the
; user's Library walls off the agent's own account with it.
(allow file-read* file-write* (subpath "/Users/you/Library/Keychains"))

; --- the agent's own world, read and write ---------------------------------
(allow file-read* file-write* (subpath "PROJECT"))
(allow file-read* file-write* (subpath "AGENTHOME"))
(allow file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))

; --- the network: the model, and Tars on the loopback ----------------------
(allow network-outbound)
(allow network-bind (local ip "localhost:*"))
```

What it took to get there, none of it obvious:

- `(deny default)` plus a list of allowed subpaths **is not enough for `/bin/sh`
  to run**: it also reads the root directory, so `(literal "/")` is required.
  Without it every command dies at exec with no message.
- The toolchain has to be named, because on this machine it lives under `$HOME`:
  `~/.nvm` (node and npm), `~/.local/bin` and `~/.local/share/claude` (the CLI
  itself). A profile allowing only `/usr` and `/opt` starts nothing.
- `git` reads `~/.gitconfig` and `~/.config/git/ignore`. Denied, it fails
  outright on the first and warns on the second.
- **The credential store has to be allowed.** Without
  `~/Library/Keychains`, the CLI answers `Not logged in - Please run /login`.
  A profile that walls off the user's `Library` walls off the agent's account
  with it.
- The network can be allowed or denied, and not much in between:
  `network-outbound` filters take an `ip "host:port"`, not a DNS name, so
  "only api.anthropic.com" is not expressible. Loopback-only was measured:
  the model becomes unreachable (`curl` to Anthropic returns nothing at all).
- A `(deny …)` rule is an `EPERM` by default and a kill with
  `(with send-signal SIGKILL)`. The kill matters when the caller swallows the
  error; `log show` does not report these refusals, so it is no use as a
  detector.

### What Noah gains

- An agent cannot read `~/Documents`, `~/.ssh`, another project's source, or
  `~/.dorothy` (the fleet's settings, every provider API key, the shared token,
  the vault). Measured, not assumed.
- An agent cannot write outside its project and the paths it is given. That is
  the failure mode with teeth: a confused agent `rm -rf`ing the wrong tree.
- It is per agent and per profile, so a read-only reviewer agent is expressible.

### What Noah loses

- **`ps` stops working entirely**, in every profile, confined or not, because it
  is setuid root. An agent debugging a stuck process loses its tool.
- Every path an agent legitimately needs must be named in advance: a second
  project, a worktree elsewhere, a scratch directory, a global npm cache. A
  missing path is a refusal, and often a silent one.
- `sandbox-exec` is deprecated by Apple. It works on macOS 26.6.1 and has worked
  for a decade; it carries no promise about the next release.
- Nothing may wrap the E2E suite in it: Chromium installs its own sandbox and a
  process already confined fails to start.
- **It does not close §3.** An agent under this profile still reads a
  colleague's token out of the process table. The sandbox is a filesystem
  boundary, not a process boundary.

### The shape it would take in Tars, if Noah wants it

`initAgentPty` is the one line every PTY starts on. A confined spawn would be
`sandbox-exec -f <profile> <the command it already builds>`, with the profile
written per agent next to its worktree from a template: the project path, the
worktree, the agent's own scratch, plus the fixed system and toolchain block
above. Opt-in per agent, defaulting to off, or every existing agent breaks on
the first path nobody thought to list.

---

## 5. What is where on disk

| Path | Holds | Reachable by an agent |
|---|---|---|
| `~/.dorothy/` | the fleet, settings, the shared token, the vault, the bus journal, the Hermes gateway's token (`hermes-connection.json`), and the files staged for a room (`bus-files/`, a week, then removed) | Yes, deliberately: it is in every agent's `--add-dir`. A file sent to one room can be read by every agent of every project, as its journal can; `bus-files/` is refused when it is a link, and each file is written in a folder of its own that must not exist yet |
| `~/.tars-private/` | Noah's conversation with the super chat, the Hermes sessions it held that conversation in (`overseer-hermes-sessions.json`), the Hermes webhook secret, and the Claude accounts' registry (`claude-accounts.json`: the option, each account's id and name, the thresholds; no credential and no folder) | Not handed to any agent, never passed to a CLI, and refused by both ways an agent has of sending a file to Telegram and by the vault's attach route. Each file `0600`, in a directory Tars makes `0700`. The conversation also lives in Hermes, one session per turn: `memory_search` (`/api/memory/search`, what agents call) leaves out every session the super chat opened, every run of its cron job (recorded when it runs, so a run of a job replaced since is still left out), a session Hermes compressed out of one of those (the gateway answers a compressed conversation under its newest id, with its `lineage_root` and `parent_session_id`, which are checked too), a session branched or delegated from any of those (the gateway's lineage stops at a branch or a delegate edge, so each parent is read further up through `GET /api/sessions/{id}`, to a root; an ancestry that cannot be read to its end, a cycle, or more than 20 parents leaves the hit out), and any hit that names no session. The gateway is asked for its most (100) and the filter runs before the agent's `limit` is applied, so the super chat's hits do not take an agent's places. When 100 or more of the super chat's lineages match before any of Noah's, an agent gets no Hermes hit: the gateway gives no further page. Sessions opened before 1.9.0 were not recorded, so only their cron runs are left out; an agent holding `hermes-connection.json` can still ask the gateway itself (§5, the paragraph below) |
| `~/.claude-accounts/<id>/` | each Claude account after the first, with several on: a Claude Code folder of its own, with its own `.claude.json` (the account's identity) and a copy of `~/.claude/settings.json`, its transcripts, history, sessions, CLAUDE.md, skills, agents, commands, plugins and output styles being links to `~/.claude`. The sign-in is Claude Code's, in the keychain item named after the folder (`.credentials.json` on Linux): Tars never opens it | Not in any agent's `--add-dir`; the agents started on an account run in its folder (`CLAUDE_CONFIG_DIR`), as account 1's run in `~/.claude`, and a folder that is not Tars's own is refused, never repaired |

So what the kanban tools let an agent do on the Hermes board (since #183, delete
only a task it filed that nobody claimed, or one it claimed) is a rule of Tars's
own tools, not a barrier: an agent that reads `hermes-connection.json` can call
the gateway with its token and edit or delete any task (the audit's gate of #183).

What an agent waits on (`waitingOn`, the command or question of an open dialog) is kept in memory only: it is not written to `agents.json`. While the dialog is open, another agent can read it through `GET /api/agents/:id?full=true`, as it can read the rest of that agent's record; a command typed with a secret in it is visible there for that long. The hook sends only the fields that name the dialog, each cut at 1000 characters, never a tool's whole input.

`~/.tars-private/overseer.json` used to be `~/.dorothy/overseer.json`: 148,654
bytes, 344 messages, mode `0644`, in the directory every agent is pointed at.
Reading it took no API call and no token.

Moving it is worth exactly what it is worth, and no more: it leaves the
directory an agent is handed and the listing it gets for free, and the `0600`
closes it to the other accounts on the machine. An agent that goes looking for
`~/.tars-private` still reads it, because §1. Closing that is §4, or nothing.

The move first took it off a list, which the audit of `bad8c97` caught on the
app's Telegram send routes, and which held for the agents' Telegram MCP server
too: both refuse `~/.dorothy` by name, and refused nothing under
`~/.tars-private`, so the conversation could be sent from where it had landed
with one call. Both refuse the private directory now. The vault's attach route
was a third way, measured on the same branch: it copies the file its caller
names into `~/.dorothy/vault/attachments`, where `/api/local-file` serves it
with no token, and it took a file from `~/.tars-private` on the shared token.
It refuses the private directory now too, by what the file is and not by how
it is named: on 2026-09-23 the audit's lead #21 was reproduced in a sandbox
app, where `~/.TARS-PRIVATE/...` (the volume ignores case) and
`/System/Volumes/Data/...` (the Data volume's firmlink) both copied the webhook
secret in and `/api/local-file` served it. The route and the app's Telegram send
routes now compare the real path, and each directory above it, with the private
directory by device and inode (`electron/utils/path-identity.ts`), so a case
variant, the firmlink or a symlink is refused like the plain name; the agents'
Telegram MCP server compares segments in any case and checks the real path too.
A hard link has no path back to the file it names, so a link made elsewhere to
a private file passed all of that; all three guards now look for its inode among
the files of the private directory, and the two Telegram ones in `~/.ssh` as
well (the audit's gate of #137).
It still copies any other file its caller names, `~/.ssh` included; that is older than 1.7.6, and closing it means
deciding what an agent may attach. Each of these is a refusal of the one-call
route, not a wall: an agent with a shell copies the file somewhere else first,
because §1.

The renderer's file channels (`fs:read-text-file`, `fs:write-text-file`,
`fs:read-project-files`, `local-file://`) confine a path to a list of roots:
`~/.dorothy`, the CLIs' folders and the projects. Until 1.9.2 a root could be
the home or a folder above it (a project added as `~` or `/Users`, or written
into `projects.json`), and the path was judged as spelled while the read or
the write followed links: one symlink under `~/.dorothy` or in a cloned
repository to the home opened `~/.ssh`, `~/.tars-private` and the shell's
startup files, to read and to write. A root that is the home or above it is
now refused, by spelling and by device and inode, and the path must really
lie, links followed, under the real location of a root
(`electron/utils/home-root.ts`, `real-target.ts`). One file link to a markdown
file outside every root and outside the Telegram guard's blocked places stays
allowed on the three IPC channels, for a CLAUDE.md kept in a dotfiles
repository. `/api/local-file`, which takes no token, got the same real-path
test without that exception, and refuses a file with a second name, since an
attachment is a copy the vault made: before, one symlink or hard link planted
in `~/.dorothy/vault/attachments` served, to any process on the loopback,
another account's included, the file it named or every file under the folder
it led to. What is left:
the check and the read are two calls, so a link swapped in between is
followed, by a process that could open the file itself (§1).

Made on a new install by the first save, the directory came out `0755`, since
only the migration asked for `0700`. Whichever write makes it now, the
migration or the first save of the conversation or of the webhook secret, makes
it `0700`. A directory that already exists at another mode is left as it is.

## 6. Who the bots answer

Each bot is a way into the fleet from outside the machine, so each answers a
list Noah keeps in Settings, and nobody when the list is empty.

- **Telegram**: the chats enrolled with `/auth <token>`. Read from the settings
  as they are at each message: before 2026-09-23 the bot held the object it was
  started with, every Settings save replaced main's, and a chat removed or a
  token regenerated kept working until a restart (the audit's lead #19). The
  app's own `/api/telegram/send*` go only to those chats, as mcp-telegram's do:
  `send_telegram`, in every agent, forwarded a chat id chosen by the model
  (lead #20). And what the bot sends of its own accord, the super agent's
  replies and errors and the status notices, goes only to a chat Settings
  allows at the moment it is sent: the chat that last asked was remembered and
  never checked again, so a chat removed after asking kept receiving all three
  (the audit's gate of #137). It is forgotten now, and what it would have
  received goes to the chats that are allowed. Since 2026-09-24, `/auth` takes
  five wrong tokens from a chat, and twenty from all chats together, in any
  fifteen minutes (the Audit's gate of #176); past that it answers "Too many
  attempts" without comparing, the same to a right token as to a wrong one. The
  token Tars generates is 128 random bits: the limit is for a token set by hand,
  and against a bot that answers a stranger for ever. The count from all chats
  is a lock-out anyone who finds the bot can cause: twenty wrong tokens in
  fifteen minutes keep every new chat out, Noah's included (chats already
  enrolled are not affected). Kept for 1.9.0 on purpose (the Audit's gate of
  #200), with its way out said in the refusal itself: "Try again at HH:MM, or
  turn Telegram off and on in Tars's Settings". The toggle restarts the bot,
  which starts the count again. Only toggling Telegram in Settings or
  restarting Tars clears it: the count lives in memory, no API route restarts
  the bot and nothing watches app-settings.json.
- **Slack**: the member ids in Settings > Slack (`slackAllowedUserIds`). Before
  it, anyone who could mention or message the bot could list agents and project
  paths, start, stop and brief them, and move the channel agents post to
  (lead #15). A sender not on the list is told its own id, in a mention or a
  direct message, so the owner can add it; other channel messages are ignored
  without a word.
- **Discord**: the user ids in Settings > Discord (`discordAllowedUserIds`), and
  in a server channel only a message that mentions the bot, unless Require
  @mention is off. A stranger is told its id where it addressed the bot. Nothing
  the bot posts can ping (`allowedMentions` with nothing in it). Its invite asks
  for View Channels and Send Messages and nothing else: until the Audit's gate
  of #195 it asked for Read Message History too, which the bot never uses.

## 7. Windows

Measured on Nicolas's machine, Windows 11 Pro 26200, on the fork's `windows`
branch at `4b26873f`, on the 25th of September 2026 (the secrets' access
lists on `win/secret-acl`, on the 28th). §1 holds there
unchanged: one account, every agent runs as it. What differs is what stands
in for the POSIX modes, and where the credentials of other programs live.

**No file mode is a boundary on Windows.** Every `0o600`, `0o700` and `chmod`
in this file's §5 and in `electron/utils/secret-file.ts` does nothing there:
Node maps `chmod` to the read-only attribute and nothing else, so
every file comes out with whatever the folder above it hands down. For most of
`~\.dorothy` that is the profile's list: `C:\Users\<name>` grants SYSTEM, the
Administrators group and the account itself, nobody else, and a file under it
inherits that. A file Tars writes outside the profile (a project on another
drive, `C:\tmp`) has whatever that place grants, often every authenticated
user.

The profile's list is not always the one that applies. On this machine
`~\.dorothy` carried an entry of its own, not inherited, that granted read to
`CodexSandboxUsers` on the folder and everything created in it (`icacls`,
2026-09-25: `CodexSandboxUsers:(OI)(CI)(RX)`). Codex's Windows sandbox setup
makes that group (its accounts `CodexSandboxOffline` and `CodexSandboxOnline`
run the commands its model runs) and grants it read on the folders the sandbox
may read. Through that entry, `api-token` and `app-settings.json` were
readable by those accounts.

**So the secrets get an access list of their own.** `api-token`,
`app-settings.json`, `hermes-connection.json` and `~\.tars-private` with
everything in it end with two entries: the account and SYSTEM, full control,
inheritance removed (`electron/platform/owner-only.ts`, `icacls` and `whoami`
by their System32 path, with an argv, the account by its SID).

When it is set matters as much as what it says. Windows checks access when a
handle is opened, Node opens files with full sharing, and a handle keeps what
it was granted: changing a file's list afterwards revokes nothing from a
handle already open. So a secret is born closed rather than closed after. The
temp file of a save of one of the three files is created in
`~\.tars-private\.staging`, a directory of the account alone, closed on its
own, so the temp holds the user and SYSTEM before its first byte; it is then
renamed into place, which on the same volume keeps that list. `api-token` is
written the same way, atomically, so a handle opened on an older token never
reads a newer one. And it is minted anew once: Tars reuses any token of 32
characters or more, so on Windows the first start of this build replaces the
one it finds, whoever read it before the file was closed, and records that in
`~\.tars-private\api-token-rotated`; every start after keeps the token, as
upstream does. darwin and linux never rotate. The shared token is read at
startup by the app and from the file, on each call, by its other readers (the
hooks, the MCP servers without an agent token of their own, the Hermes
handlers), so they follow; what can hold the old one is a process that read
it before the restart and is still running, such as a scheduled task of an
API-key provider that exported it at its start. At startup, in the background (seconds on a busy
machine), each of the three files that exists is born again the same way, a new
file object with the same contents, rather than having its list changed in
place; the private directory is made if it is missing and closed, its entries
taking its list, a link or junction in it not followed. A file written into
the private directory takes the directory's list and starts nothing.

What remains. Until the staging directory is closed, or when it cannot be (a
file or a link at its name, no `icacls`), a save falls back to the old order,
the temp beside the target under its folder's list and closed before the
rename, and says so in the log; the first save of a run closes the staging
directory itself if the startup pass has not yet. Closing it removes any grant
of its own it carried; a staging directory removed later is made and closed
again by the next save. A handle opened on a file
before this build first ran keeps reading that file object, but the token it
holds is the old one, which the one-time rotation has made worthless. When
another program holds `api-token` open as a new token is minted, the rename is
refused; rather than stop the app, the token is written in place, closed, and
that is logged, and that holder reads the new token. When the startup pass closes the private
directory its list is reset and set again, and for that moment what inherits
from it (the conversation files, not the staging directory, which keeps its
own) has the home's list. A failure (no `icacls`, a file held) is logged with
the path and the write is kept. `hermes-session.json`, the gateway's cookies,
is left out on purpose: it is rewritten on every reply that sets a cookie, and
one `icacls` is a process start on the main process (25 ms idle, about 400 ms
on a busy machine, which took one test file from 0.6 s to 13 s); it keeps
`~\.dorothy`'s list as before. `~\.dorothy` itself and its other files keep
the profile's list: it is the agents' directory, and a Codex sandbox reads it.

What that list keeps out: every other account on the machine. Another
standard user, a guest, a service account, the Codex sandbox accounts, and
any grant added to `~\.dorothy` later, since nothing is inherited any more.
The Administrators group loses its standing entry, but an administrator can
take ownership, so that is no boundary. It also closes these files when the
home is outside the profile (a `USERPROFILE` on another drive).

What it does not keep out: anything that runs as the account. **It is not a
boundary against the agents**: every CLI Tars starts, its hooks, its MCP
servers and whatever an agent runs are the same user with full control, and
read these files as before (§1). Nor SYSTEM, which backup and antivirus
software run as, nor a copy: a backup, a sync client or an agent that copies
the file elsewhere hands the copy that place's list.

Who has to keep reading them, checked on this branch: the app, the Node hook
runner (`api-token`, as a fallback to the agent's own token) and the MCP
servers (`app-settings.json` for Telegram, X and SocialData, `api-token` as a
fallback) all run as the account; a Node process of the account reads a
closed file in `__tests__/electron/platform/owner-only.test.ts`. Codex gets no
Tars hooks (`codex-provider.ts`), and starts its MCP servers itself, as the
account; only the commands its sandbox runs lose these two files, and nothing
Tars ships asks them to read one: an agent holds its own token in
`CLAUDE_MGR_API_TOKEN`. Not measured with a live Codex session: a sandboxed
Codex command that `cat`s `api-token` is now refused, by design.

**Credentials that are not dotfiles.** Both ways an agent has of sending a file
to Telegram (the app's `/api/telegram/send-*` routes and the Telegram MCP
server) refuse the home's dotfiles by name (§5). Windows programs keep theirs
under `%APPDATA%` and `%LOCALAPPDATA%` instead, and until this lot both guards
sent them: the GitHub CLI's `hosts.yml`, gcloud's `credentials.db`, the
browsers' profiles (cookies, saved passwords), DPAPI's master keys
(`Microsoft\Protect`, which decrypt the rest), the Credential Manager's files,
Tars's own Electron profile (`%APPDATA%\tars`). Both guards refuse those now,
without regard to case, where the variables point and in their default place
(`electron/platform/credential-stores.ts`, the server's copy held equal to it by
a test). The list is of stores, not of every program: a tool that keeps a token
somewhere else in AppData is not on it. macOS has the same gap in `~/Library`
(Keychains, browser profiles, Tars's own profile), left as it was.

**The notification sound was a way to run code.** Its path is read from
`app-settings.json`, which every agent can write (§5), and Windows played it by
pasting the path into PowerShell code: a file named with a `'` ran what
followed, in a process the main process started (measured with a canary file:
the old command ran it). The path now reaches a fixed, encoded script as data,
in the environment, never in the code; only an existing local `.wav` is played,
a UNC path is refused before it is opened (the lookup alone would send the
account's NTLM hash to that host), and PowerShell is System32's, by its full
path, with no profile (`electron/platform/sound.ts`). A symlink or junction on
the way that leads to a share or a device is refused as well. Known gap: a
drive letter mapped to a share (`net use X: \\host\share`) passes the check as
`X:\a.wav`, and playing it contacts that host.

**Replacing a file someone is reading.** The atomic writes (§5, ETHOS 7) end in
a rename over the live file, which Windows refuses while any process has it
open, even to read. They are tried again for about a second and then fail with
a message that names the file and says it may be held open by another program
(`electron/platform/rename-replacing.ts`); `agents.json` goes the same way.
What holds in every measurement: the retry is bounded, it is never worse than
a plain rename, and no reader ever saw a partial file. How much it buys does
not reproduce: under twenty reading processes the numbers moved from one run
to the next, and the file was at times held for several seconds (6 to 10 s,
seen by the reviewer's probe; an antivirus or another holder, unconfirmed),
which a one-second retry does not cover. A save can therefore still fail, with
an error that names the file. The measurement is kept, opt-in:
`TARS_STRESS=1 npx vitest run __tests__/electron/platform/rename-replacing.test.ts`.

## 8. The machines bridge

Settings > Machines pairs this Tars with another one on the same tailnet, so
that each can see the other's agents (and, later, drive them where allowed).
Measured on the fork's `win/machines` branch on the 2nd of October 2026, with
two Tars on one machine (`e2e/machines-pairing.spec.ts`) and the bridge's
units (`__tests__/electron/machines/`).

**What listens.** A second HTTP server, `electron/services/machines/bridge-server.ts`,
apart from the loopback API of §2. It binds this machine's Tailscale IPv4 on
port 31418, and nothing at all when Tailscale gives no address: never
`0.0.0.0`, never Funnel, never `tailscale serve`. It answers only callers
from the tailnet's range (100.64.0.0/10), refusing anyone else with a 403:
macOS hands a socket bound to the Tailscale address what arrives over the
LAN for that address too. It starts only once a
machine is paired, or while a pairing code is shown, and stops in the quit's
first pass. A development run may bind `127.0.0.1` instead
(`TARS_MACHINES_BIND`, `TARS_MACHINES_PORT`, `TARS_MACHINES_PEERS`); a
packaged Tars never reads those.

**What it answers.** Five routes, listed one by one; any other path is a 404
before a credential is read, and no route of the loopback API answers here.
They are not hidden: `ping` and `unpair` answer 401 without a paired
machine's secret, so a prober on the tailnet can tell a Tars listens.

| Route | Who | What |
|---|---|---|
| `GET /machines/v1/hello` | anyone on the tailnet | this machine's id, name and the offer's nonce, only while a code is shown; 404 otherwise |
| `POST /machines/v1/knock` | anyone on the tailnet, while a code is shown | its id and name, no proof; held up to a minute until the person here accepts or refuses |
| `POST /machines/v1/pair` | the machine the person here accepted, from the address it knocked from, within 30 seconds | a proof of the code; on success a secret issued to it |
| `GET /machines/v1/ping` | a paired machine | this machine's name and how many agents run |
| `POST /machines/v1/unpair` | a paired machine | this machine forgets the caller |

A request carrying an `Origin` header is refused (no browser ever calls the
bridge), and a body over 64 KB is refused unread.

**Who is admitted.** A paired machine, by the secret this Tars issued to it
at pairing. `~/.tars-private/machines.json` keeps the sha256 of that secret,
compared in constant time, and the secret the other machine issued to this
one, in clear because it has to be presented. The loopback API's shared
token, Tars's pass and the Hermes webhook secret open nothing here.

**What pairing proves.** The machine showing the code draws six digits and a
nonce, and the typing machine draws one of its own for each pairing. Both
sides key their proofs by the code stretched with scrypt over both nonces
(N 2^15, r 8: 32 MiB and 110 ms per code, measured on a desktop PC), so no
key can be worked out before the typing machine's nonce is sent. The typing
machine sends `HMAC-SHA256(key, nonce:its nonce:its id)`, never the code;
the offering machine answers with `HMAC-SHA256(key, answer:nonce:caller
nonce:caller id:its id)`, and the typing machine stores nothing without it, nor an answer
whose id is not the one `hello` gave, whose name a typed name could not be,
or whose secret is not the 43 characters a secret is. Either side refuses a
secret of another shape. An offer is good for five minutes by the offering
machine's clock, five wrong proofs and one success, and refuses a machine
pairing with itself. A machine another tailnet shares into yours
(`ShareeNode`) is never asked for a code.

**Who decides.** Before any proof, the typing machine knocks. The machine
showing the code names the caller by the MagicDNS name of the device at its
address, which the tailnet keeps unique (a device that sets its hostname to
another's gets `name-1`), and by that address, which WireGuard authenticates;
nothing more happens until the person there clicks Accept. One machine at a
time: from its knock to the end of its half minute to prove the code, any
other is turned away, and a knock asks Tailscale one quick question, never
several at once. A refusal, or a minute without an answer, spends
the code. Only the accepted machine, from the address it knocked from, may
then send its proof, within 30 seconds, and it is stored under the name the
person saw. A new code, or a closed one, ends the request waiting on the old
one, and a request never waits past its code's five minutes. The typing
machine waits up to 75 seconds for that click, and five seconds for the
answer to its proof.

**What is left.** A hostile device of your own tailnet that answered `hello`
in the offering machine's place can accept the knock itself and receive the
typing machine's proof. It cannot have worked any key out before, since the
key takes the typing machine's fresh nonce, and 10^6 codes cost some 30 CPU
hours: within the five seconds the typing machine waits, it pairs with
nothing. It can keep the proof, find the code later on many cores or a GPU,
and knock on the real offering machine within the offer's five minutes: the
person there sees its MagicDNS name and address, not the machine expected,
and refuses. A person who accepts a device they do not recognise is what
remains; Tailscale's access rules, which can keep every other device off port
31418, close that too. A PAKE (CPace, SPAKE2) would remove the offline search
altogether; the code's short life and the person's click stand in for it.

**What a paired machine may do here.** See, by default; Drive only when this
machine says so in Settings > Machines. The machine being driven decides,
never the caller. In this first part the bridge serves no agent, no
terminal and no file: what See and Drive open is the next plans'.
