#!/bin/bash
# Session end hook for tars (Gemini CLI)

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

api_post /api/hooks/status \
  "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"completed\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
