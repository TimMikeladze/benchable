/** Per-agent MCP config for the Benchable server. The key always comes from an env var. */
export const MCP_AGENTS = ["claude-code", "codex", "opencode"] as const;
export type McpAgent = (typeof MCP_AGENTS)[number];

export function mcpSnippet(agent: McpAgent, url: string): string {
  const endpoint = `${url.replace(/\/+$/, "")}/api/mcp`;
  switch (agent) {
    case "claude-code":
      return [
        "# Claude Code: run once (add --scope user to use it in every project)",
        `claude mcp add --transport http benchable ${endpoint} --header "Authorization: Bearer $BENCHABLE_KEY"`,
      ].join("\n");
    case "codex":
      return [
        "# Codex: run once",
        `codex mcp add benchable --url ${endpoint} --bearer-token-env-var BENCHABLE_KEY`,
        "# or add to ~/.codex/config.toml",
        "[mcp_servers.benchable]",
        `url = "${endpoint}"`,
        'bearer_token_env_var = "BENCHABLE_KEY"',
      ].join("\n");
    case "opencode":
      return [
        "// OpenCode: opencode.json (project) or ~/.config/opencode/opencode.json",
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              benchable: {
                type: "remote",
                url: endpoint,
                headers: { Authorization: "Bearer {env:BENCHABLE_KEY}" },
              },
            },
          },
          null,
          2,
        ),
      ].join("\n");
  }
}
