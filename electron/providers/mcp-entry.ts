/**
 * Whether an MCP entry a provider wrote (`{ command, args }`) starts the
 * server at `serverPath`: as its command (gws on macOS: `<gws> mcp -s ...`)
 * or as one of its arguments (`node <bundle.js>`, `npx tsx <server.ts>`, and
 * on Windows `node <gws script> mcp -s ...`). Compared on the parsed fields,
 * never on the serialised entry, where a Windows path's backslashes are
 * doubled. The one rule every provider's isMcpServerRegistered applies: they
 * compared the last argument (the service list, for gws) or the JSON text.
 */
export function mcpEntryRuns(entry: unknown, serverPath: string): boolean {
  if (!serverPath || !entry || typeof entry !== 'object') return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (command === serverPath) return true;
  return Array.isArray(args) && args.includes(serverPath);
}
