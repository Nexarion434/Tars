#!/usr/bin/env node
/**
 * MCP server for Twitter/X data via SocialData API
 * Available to all Claude agents for searching tweets, getting user profiles, etc.
 *
 * Tars makes the calls with the user's SocialData key, which it keeps in ~/.tars-private (utils/api.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTweetTools } from "./tools/tweets.js";
import { registerUserTools } from "./tools/users.js";

// Create MCP server
const server = new McpServer({
  name: "dorothy-socialdata",
  version: "1.0.0",
});

// Register all tools
registerSearchTools(server);
registerTweetTools(server);
registerUserTools(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP SocialData server running on stdio");
}

main().catch(console.error);
