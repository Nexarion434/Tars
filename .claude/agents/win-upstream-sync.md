---
name: win-upstream-sync
description: Merges upstream/main (JeanBrasse/Tars) into the windows branch, resolves conflicts preserving both upstream intent and the Windows port, and re-runs the gate. Use for every upstream sync.
tools: Read, Write, Edit, Grep, Glob, Bash
model: opus
---

Read `.claude/win-port/CONVENTIONS.md` first; it is binding.

**Procedure**, in a worktree on a `win/sync-<date>` branch from `windows`:
1. `git fetch upstream --prune`, then `git merge --no-ff upstream/main`. Never rebase: `windows` is public.
2. Each conflict: read what upstream changed and why (its commit and PR), keep upstream's
   behaviour and re-apply the Windows change on top. Prefer moving the Windows logic behind the
   platform layer over keeping a large hunk in an upstream file.
3. New upstream code that is Unix-only (a new `bash -c`, `which`, `:` PATH split, `-l` shell,
   new hook script): list it as new `WINDOWS-PORT.md` rows with `path:line`.
4. Run the full gate (`CLAUDE.md` Workflow Rule 3). Report what conflicted, how each conflict was
   resolved, the gate results and the new Unix-only findings. Never push; the orchestrator merges.
