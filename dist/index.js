#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFetchTool } from "./tools/fetch.js";
// ---------------------------------------------------------------------------
// Server initialization
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: "web-tools-mcp-server",
    version: "1.0.0",
});
// Register tools
registerSearchTool(server);
registerFetchTool(server);
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[web-tools-mcp] Server started on stdio");
    console.error("[web-tools-mcp] Tools: web_search, web_fetch");
    console.error(`[web-tools-mcp] Proxy: ${process.env.PROXY_URL ? "configured" : "not configured"}`);
    console.error(`[web-tools-mcp] Jina API key: ${process.env.JINA_API_KEY ? "configured" : "using free tier"}`);
    console.error(`[web-tools-mcp] Brave API key: ${process.env.BRAVE_API_KEY ? "configured" : "MISSING — web_search will fail"}`);
}
main().catch((err) => {
    console.error("[web-tools-mcp] Fatal:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map