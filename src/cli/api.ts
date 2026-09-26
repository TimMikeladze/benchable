/**
 * The CLI's building blocks as a library: config resolution, the login device flow, local
 * runs and sync. The `benchable` binary is a thin dispatcher over these; the
 * Benchable app's integration tests drive them directly.
 */
export * from "./config";
export { login, LOGIN_CLIENTS, type LoginOptions, type LoginResult } from "./login";
export { mcpSnippet, MCP_AGENTS, type McpAgent } from "./mcp-config";
export * from "./local/store";
export { cloudUrls, readSyncState, syncLocal, type SyncOutcome, type SyncTarget } from "./local/sync";
