#!/bin/bash
# Session start hook for tars (Gemini CLI)

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"

if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# `source` marks this as a SessionStart registration: the server records the
# session id WITHOUT touching status. Without it, the stale-session guard
# would reject every later post from this session once a previous Gemini
# session had registered.
api_post /api/hooks/status \
  "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\", \"source\": \"startup\"}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
