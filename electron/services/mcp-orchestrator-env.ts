/**
 * The variables Tars's MCP servers read from their environment (mcp-shared/src/tars-api.ts and the servers' own):
 * which agent they run for, its project and name, which Tars to call and its token, and the instance they prove
 * the port with. A CLI that hands its MCP servers only the variables it is told to (codex: `env_vars`, measured on
 * codex-cli 0.163.0) is told these names; their values stay in each agent's own environment (spawnAgentPty).
 */
export const TARS_MCP_ENV: readonly string[] = [
  'CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN',
  'TARS_INSTANCE_ID', 'TARS_CHATS_READ',
];
