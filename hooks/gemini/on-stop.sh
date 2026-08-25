#!/bin/bash
# Stop hook for tars (Gemini CLI)
# Sets agent status to "waiting"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

api_post /api/hooks/status \
  "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"waiting\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
