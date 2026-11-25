#!/usr/bin/env node
// stdio entry point — what a local MCP client spawns.
import "./stdio-env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[web-tools-mcp] Server started on stdio");
  console.error("[web-tools-mcp] Tools: web_search, web_fetch, web_bulk_fetch");
  console.error(
    `[web-tools-mcp] BrightData: ${process.env.BRIGHTDATA_API_KEY ? "configured" : "MISSING — web_fetch only works for local URLs"}`
  );
  console.error(
    `[web-tools-mcp] Brave API key: ${process.env.BRAVE_API_KEY ? "configured" : "MISSING — web_search will fail"}`
  );
}

main().catch((err) => {
  console.error("[web-tools-mcp] Fatal:", err);
  process.exit(1);
});
