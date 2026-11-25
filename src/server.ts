import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool } from "./tools/search.js";
import { registerFetchTool } from "./tools/fetch.js";

export const SERVER_INSTRUCTIONS = `Web search and page reading.
- web_search: Brave Search. The key is on a free plan (1 request/second, 2,000 searches/month shared by all clients), so search deliberately: one well-phrased query, then read the best results, rather than many reworded searches. Each result reports the searches left this month.
- web_fetch: read one page as markdown, main content only by default (no site menus, sidebars, footers or sign-up forms; content="full" for everything). To read only part of a long page: find="<text>" (or /regex/) returns the paragraphs around each match; section="<heading>" returns whole sections by heading; outline=true lists the headings with offsets. Long pages come in chunks — continue with start_index.
- web_bulk_fetch: read 3-10 pages in one call (shared size budget); find works here too.`;

/** A fresh MCP server with all tools registered (one per stdio process or HTTP request). */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "web-tools-mcp-server", version: "1.3.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerSearchTool(server);
  registerFetchTool(server);
  return server;
}
