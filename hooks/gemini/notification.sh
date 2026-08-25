#!/bin/bash
# Notification hook for tars (Gemini CLI)

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

AGENT_ID="${DOROTHY_AGENT_ID:-$SESSION_ID}"
PROJECT_PATH="${DOROTHY_PROJECT_PATH:-$CWD}"

if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# Forward notification to tars
if [ -n "$MESSAGE" ]; then
  SAFE_MSG=$(echo "$MESSAGE" | jq -Rs .)
  api_post /api/hooks/notification \
    "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"message\": $SAFE_MSG, \"project_path\": \"$PROJECT_PATH\"}" \
    > /dev/null 2>&1
fi

echo '{"continue":true,"suppressOutput":true}'
exit 0
