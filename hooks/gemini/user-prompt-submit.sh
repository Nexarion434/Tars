#!/bin/bash
# UserPromptSubmit hook for tars (Gemini CLI)
# Sets agent status back to "running" when user submits a new prompt mid-session

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

echo "[$(date)] GEMINI USER_PROMPT_SUBMIT hook. AGENT_ID=${DOROTHY_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> /tmp/dorothy-hooks.log

if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

api_post /api/hooks/status \
  "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
