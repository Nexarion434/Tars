#!/bin/bash
# Shared plumbing for the Tars hooks.
#
# Two things every hook used to get wrong on its own, and both of them cost
# the same thing: an agent whose status is a lie for the rest of the day.
#
# The port was written into each script as 31415. A Tars started on another
# port - the sandbox, an e2e run - had its agents posting their status to
# whatever was listening on 31415, which is somebody's real instance.
#
# And every post was a single `curl --max-time 3` whose result was thrown
# away. The status lifecycle is these posts and nothing else: if the one that
# says "idle" is lost, nobody says it again. Retrying is the difference
# between a hiccup and a permanent wrong answer.

TARS_API_URL="http://127.0.0.1:${DOROTHY_API_PORT:-31415}"

# api_post <path> <json-body>
#
# Three attempts, ~0.4s then ~1.2s apart, then gives up. Deliberately quick:
# a hook runs inside the agent's turn and Claude Code allows it 30 seconds.
# Prints the last response body; returns non-zero if none of the attempts
# reached the server.
#
# Only transport failures are retried. curl exits 0 on a 4xx, and a 4xx here
# means the server considered the post and refused it - a stale session, a
# missing agent - which retrying cannot change.
api_post() {
  local path="$1" body="$2" out=""
  local delay
  for delay in 0.4 1.2 ""; do
    if out=$(curl -sS --connect-timeout 2 --max-time 8 -X POST "$TARS_API_URL$path" \
      -H "Content-Type: application/json" -d "$body" 2>&1); then
      printf '%s' "$out"
      return 0
    fi
    [ -n "$delay" ] && sleep "$delay"
  done
  printf '%s' "$out"
  return 1
}

# api_up: is the app there at all? Used by the hooks that would rather do
# nothing than hold up a turn when Tars is not running.
api_up() {
  curl -s --connect-timeout 1 "$TARS_API_URL/api/health" > /dev/null 2>&1
}
