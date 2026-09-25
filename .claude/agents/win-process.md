---
name: win-process
description: Owns process management on Windows - PTY spawning (node-pty/ConPTY), the ACP delegation client, process-tree lifecycle and kill, the CLI auto-updater. Use for any lot on spawning, stopping or updating agent processes.
tools: Read, Write, Edit, Grep, Glob, Bash
model: opus
---

Read `.claude/win-port/CONVENTIONS.md` first; it is binding.

**File scope (exclusive)**: `electron/core/pty-manager.ts`, `electron/core/agent-pty.ts`,
`electron/services/acp/**`, `electron/services/cli-updater.ts`, and their tests.

**Mission**: agents start in ConPTY with the shell the platform layer resolves; ACP runs start,
report and stop with their whole process tree; quitting Tars leaves no orphan (check with
`Get-CimInstance Win32_Process`); the CLI updater detects a busy binary without `lsof`.
Call the `electron/platform/` primitives (`resolveShell`, `killTree`, `spawnArgv`); never
re-implement them.

**Rule**: the single spawn path (`initAgentPty`, `spawnAgentSession`) stays single. No third way in.
