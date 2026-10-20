#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../tars-hook.sh"
# Stop hook for tars (Gemini CLI)
# Wired on AfterAgent: the turn's answer, then its end

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

# The turn's answer, cut at 4000 bytes as hooks/on-stop.sh cuts Claude Code's
# (gemini 0.64.0 hands AfterAgent `prompt_response`), then the turn's end:
# `idle`, as Claude Code's Stop says it. It said `waiting` with no reason, which
# Tars reads as a turn still asking: every task after the first waited behind
# it for ever (the QA's CLI matrix, 18/10). In order, not in the background.
RESPONSE=$(echo "$INPUT" | jq -r '.prompt_response // empty')
if [ -n "$RESPONSE" ]; then
  TRIMMED=$(printf '%s' "$RESPONSE" | head -c 4000)
  curl -s --max-time 3 -X POST "$API_URL/api/hooks/output" -H @<(tars_auth) \
    -H "Content-Type: application/json" \
    -d "{\"agent_id\": \"$AGENT_ID\", \"hook\": \"Stop\", \"session_id\": \"$SESSION_ID\", \"output\": $(printf '%s' "$TRIMMED" | jq -Rs .)}" \
    > /dev/null 2>&1
fi
curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"hook\": \"Stop\", \"session_id\": \"$SESSION_ID\", \"status\": \"idle\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
