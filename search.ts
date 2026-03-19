import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { braveSearch } from "../services/brave-search.js";

const WebSearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "Search query is required")
    .max(400, "Query must not exceed 400 characters")
    .describe("Search query string (1-6 words recommended for best results)"),
  count: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Number of results to return (max 20)"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Offset for pagination"),
  country: z
    .string()
    .length(2)
    .optional()
    .describe("Two-letter country code for localized results (e.g., 'us', 'gb', 'de')"),
  search_lang: z
    .string()
    .optional()
    .describe("Search language code (e.g., 'en', 'fr', 'de')"),
  freshness: z
    .string()
    .optional()
    .describe(
      "Time filter: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'"
    ),
}).strict();

type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description: `Search the web using the Brave Search API. Returns titles, URLs, descriptions, and snippets.

This tool replaces the native web_search with anti-detection capabilities — queries go through the Brave Search API with your own API key, avoiding IP blocks.

Args:
  - query (string, required): Search query. Keep it short and specific (1-6 words).
  - count (number, optional): Number of results, 1-20. Default: 10.
  - offset (number, optional): Pagination offset. Default: 0.
  - country (string, optional): Two-letter country code for localized results.
  - search_lang (string, optional): Language code (e.g., 'en').
  - freshness (string, optional): Time filter — 'pd', 'pw', 'pm', 'py', or 'YYYY-MM-DDtoYYYY-MM-DD'.

Returns:
  Search results with title, url, description for each result. Includes extra_snippets when available.

Examples:
  - "latest Node.js release" -> query="Node.js latest release", freshness="pw"
  - "Python asyncio tutorial" -> query="Python asyncio tutorial"`,
      inputSchema: WebSearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: WebSearchInput) => {
      try {
        const result = await braveSearch(
          params.query,
          params.count,
          params.offset,
          params.country,
          params.search_lang,
          params.freshness
        );

        if (result.error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Search error: ${result.error}`,
              },
            ],
          };
        }

        if (result.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${params.query}". Try broader terms or remove filters.`,
              },
            ],
          };
        }

        // Format as markdown for readability
        const lines: string[] = [
          `# Search Results: "${result.query}"`,
          `Found ${result.results.length} results`,
          "",
        ];

        for (let i = 0; i < result.results.length; i++) {
          const r = result.results[i];
          lines.push(`## ${i + 1}. ${r.title}`);
          lines.push(`**URL**: ${r.url}`);
          if (r.age) lines.push(`**Age**: ${r.age}`);
          lines.push("");
          lines.push(r.description);
          if (r.extra_snippets?.length) {
            lines.push("");
            lines.push("**Additional context:**");
            for (const snippet of r.extra_snippets) {
              lines.push(`> ${snippet}`);
            }
          }
          lines.push("");
          lines.push("---");
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
