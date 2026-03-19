import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl } from "../services/fetcher.js";
import { FetchStrategy } from "../constants.js";

const WebFetchInputSchema = z.object({
  url: z
    .string()
    .url("Must be a valid URL with scheme (e.g., https://example.com)")
    .describe("Full URL to fetch, must include https:// or http://"),
  strategy: z
    .enum(["auto", "direct", "jina"])
    .default("auto")
    .describe(
      "Fetch strategy: 'auto' (try direct with proxy+UA rotation, fallback to Jina Reader), 'direct' (only direct fetch with rotating UA + optional proxy), 'jina' (only Jina Reader — best for JS-heavy sites and anti-bot bypassing)"
    ),
}).strict();

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

const strategyMap: Record<string, FetchStrategy> = {
  auto: FetchStrategy.AUTO,
  direct: FetchStrategy.DIRECT,
  jina: FetchStrategy.JINA,
};

export function registerFetchTool(server: McpServer): void {
  server.registerTool(
    "web_fetch",
    {
      title: "Web Fetch",
      description: `Fetch the contents of a web page with anti-detection capabilities.

This tool replaces the native web_fetch. It uses rotating real-browser user agents, optional proxy (Bright Data or any HTTP/SOCKS5), and automatic fallback to Jina Reader API for sites that block direct access.

Three fetch strategies:
  - "auto" (default): Tries direct fetch first (with UA rotation + proxy if configured). If blocked (403/429/503/captcha), automatically falls back to Jina Reader.
  - "direct": Direct HTTP fetch only. Uses rotating browser user agents and your configured proxy. Returns raw HTML.
  - "jina": Uses Jina Reader API exclusively. Best for JS-heavy sites. Returns clean LLM-ready markdown. Handles rendering server-side.

Environment variables:
  - PROXY_URL: HTTP/HTTPS/SOCKS5 proxy URL (e.g., Bright Data: http://user:pass@brd.superproxy.io:22225)
  - JINA_API_KEY: Optional Jina API key for higher rate limits (free tier works without key)

Args:
  - url (string, required): The URL to fetch. Must include https:// or http://.
  - strategy (string, optional): "auto", "direct", or "jina". Default: "auto".

Returns:
  Page content (HTML for direct, markdown for Jina), HTTP status, final URL after redirects, and which strategy was used.

Examples:
  - Fetch a docs page: url="https://docs.python.org/3/library/asyncio.html"
  - Force Jina for JS-heavy site: url="https://example.com/spa", strategy="jina"
  - Force direct for API/JSON: url="https://api.example.com/data.json", strategy="direct"`,
      inputSchema: WebFetchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: WebFetchInput) => {
      try {
        const strategy = strategyMap[params.strategy] ?? FetchStrategy.AUTO;
        const result = await fetchUrl(params.url, strategy);

        if (result.error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Fetch failed for ${params.url}:\n${result.error}`,
              },
            ],
          };
        }

        if (!result.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `HTTP ${result.status} fetching ${params.url} (strategy: ${result.strategy}).\n\nResponse body:\n${result.content.slice(0, 2000)}`,
              },
            ],
          };
        }

        const meta = [
          `URL: ${result.url}`,
          `Status: ${result.status}`,
          `Strategy: ${result.strategy}`,
          `Content-Type: ${result.contentType}`,
          `Size: ${result.content.length} chars`,
        ].join(" | ");

        return {
          content: [
            {
              type: "text" as const,
              text: `${meta}\n\n${result.content}`,
            },
          ],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
