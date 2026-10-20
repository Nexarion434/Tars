#!/usr/bin/env node
/**
 * MCP server that exposes Telegram tools for sending messages, photos, videos,
 * and documents. Tars sends them, with the bot's token it keeps in
 * ~/.tars-private (tools.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTelegramTools } from "./tools.js";

export { windowsCredentialStoreDirs } from "./tools.js";

// Create MCP server
const server = new McpServer({
  name: "claude-mgr-telegram",
  version: "1.0.0",
});

registerTelegramTools(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Telegram server running on stdio");
}

main().catch(console.error);
