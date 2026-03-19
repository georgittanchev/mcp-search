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
        .describe("Fetch strategy: 'auto' (try direct with proxy+UA rotation, fallback to Jina Reader), 'direct' (only direct fetch with rotating UA + optional proxy), 'jina' (only Jina Reader — best for JS-heavy sites and anti-bot bypassing)"),
}).strict();
const WebBulkFetchInputSchema = z.object({
    urls: z
        .array(z.string().url("Each URL must include https:// or http://"))
        .min(1, "At least one URL is required")
        .max(10, "Maximum 10 URLs per batch")
        .describe("Array of URLs to fetch in parallel (max 10)"),
    strategy: z
        .enum(["auto", "direct", "jina"])
        .default("auto")
        .describe("Fetch strategy applied to all URLs: 'auto' (default), 'direct', or 'jina'"),
}).strict();
const strategyMap = {
    auto: FetchStrategy.AUTO,
    direct: FetchStrategy.DIRECT,
    jina: FetchStrategy.JINA,
};
function formatResult(url, result) {
    if (result.error) {
        return `## FAILED: ${url}\nError: ${result.error}`;
    }
    if (!result.ok) {
        return `## FAILED: ${url}\nHTTP ${result.status} (strategy: ${result.strategy})\n\n${result.content.slice(0, 2000)}`;
    }
    const meta = [
        `URL: ${result.url}`,
        `Status: ${result.status}`,
        `Strategy: ${result.strategy}`,
        `Content-Type: ${result.contentType}`,
        `Size: ${result.content.length} chars`,
    ].join(" | ");
    return `${meta}\n\n${result.content}`;
}
export function registerFetchTool(server) {
    server.registerTool("web_fetch", {
        title: "Web Fetch",
        description: `Fetch the contents of a web page with anti-detection capabilities.

This tool replaces the native web_fetch. It uses rotating real-browser user agents, optional proxy (Bright Data or any HTTP/SOCKS5), and automatic fallback to Jina Reader API for sites that block direct access.

Three fetch strategies:
  - "auto" (default): Tries direct fetch first (with UA rotation + proxy if configured). If blocked (403/429/503/captcha), automatically falls back to Jina Reader.
  - "direct": Direct HTTP fetch only. Uses rotating browser user agents and your configured proxy. Returns raw HTML.
  - "jina": Uses Jina Reader API exclusively. Best for JS-heavy sites. Returns clean LLM-ready markdown. Handles rendering server-side.

For fetching multiple URLs at once, use web_bulk_fetch instead — it's faster and uses a single tool call.

Args:
  - url (string, required): The URL to fetch. Must include https:// or http://.
  - strategy (string, optional): "auto", "direct", or "jina". Default: "auto".

Returns:
  Page content (HTML for direct, markdown for Jina), HTTP status, final URL after redirects, and which strategy was used.`,
        inputSchema: WebFetchInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const strategy = strategyMap[params.strategy] ?? FetchStrategy.AUTO;
            const result = await fetchUrl(params.url, strategy);
            const text = formatResult(params.url, result);
            return {
                isError: !!(result.error || !result.ok),
                content: [{ type: "text", text }],
            };
        }
        catch (err) {
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ],
            };
        }
    });
    server.registerTool("web_bulk_fetch", {
        title: "Web Bulk Fetch",
        description: `Fetch multiple URLs in parallel with anti-detection capabilities. Much faster than calling web_fetch multiple times.

Use this after web_search to fetch the top 3-4 results in a single call instead of making separate web_fetch calls.

Args:
  - urls (string[], required): Array of URLs to fetch (max 10). Each must include https:// or http://.
  - strategy (string, optional): "auto", "direct", or "jina". Applied to all URLs. Default: "auto".

Returns:
  Combined results for all URLs, each with page content, HTTP status, strategy used, and content size. Failed URLs are clearly marked.

Example:
  urls=["https://docs.python.org/3/library/asyncio.html", "https://nodejs.org/en/docs/guides/event-loop"]`,
        inputSchema: WebBulkFetchInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    }, async (params) => {
        const strategy = strategyMap[params.strategy] ?? FetchStrategy.AUTO;
        const results = await Promise.allSettled(params.urls.map((url) => fetchUrl(url, strategy)));
        const sections = [];
        let hasErrors = false;
        for (let i = 0; i < params.urls.length; i++) {
            const url = params.urls[i];
            const settled = results[i];
            sections.push(`\n${"=".repeat(80)}\n# [${i + 1}/${params.urls.length}] ${url}\n${"=".repeat(80)}`);
            if (settled.status === "fulfilled") {
                const result = settled.value;
                if (result.error || !result.ok)
                    hasErrors = true;
                sections.push(formatResult(url, result));
            }
            else {
                hasErrors = true;
                sections.push(`## FAILED: ${url}\nError: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
            }
        }
        const summary = `Fetched ${params.urls.length} URLs | Strategy: ${params.strategy} | ${hasErrors ? "Some failed — see details below" : "All succeeded"}`;
        return {
            isError: false,
            content: [{ type: "text", text: `${summary}\n${sections.join("\n")}` }],
        };
    });
}
//# sourceMappingURL=fetch.js.map