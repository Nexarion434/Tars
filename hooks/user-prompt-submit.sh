#!/bin/bash
# UserPromptSubmit hook for tars
# Sets agent status back to "running" when user submits a new prompt mid-session

# Read JSON input from stdin
INPUT=$(cat)

# Extract info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

echo "[$(date)] USER_PROMPT_SUBMIT hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID" >> /tmp/dorothy-hooks.log

# API endpoint, retries and health check
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Get agent ID from environment or use session ID
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"

# Check if API is available
if ! api_up; then
  echo '{"continue":true,"suppressOutput":true}'
  exit 0
fi

# Update agent status to "running" and set current task to the user's prompt
api_post /api/hooks/status \
  "{\"agent_id\": \"$AGENT_ID\", \"session_id\": \"$SESSION_ID\", \"status\": \"running\", \"current_task\": $(echo "$PROMPT" | head -c 200 | jq -Rs .)}" \
  > /dev/null 2>&1

echo '{"continue":true,"suppressOutput":true}'
exit 0
