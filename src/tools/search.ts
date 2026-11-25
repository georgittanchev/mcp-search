import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { braveSearch, BraveSearchResponse } from "../services/brave-search.js";

// Hostname labels that mark a test/staging copy of a site (e.g. docs-test.cloudlinux.com):
// they often outrank the live site with stale content. Only subdomain labels are
// checked, never the registrable domain, so dev.to or test.com are left alone.
// A bare "dev." is NOT flagged: developer portals use it (dev.mysql.com,
// dev.twitch.tv). Only numbered or suffixed forms (dev2., api-dev.) are.
const TEST_WORD = "(?:test|tests|testing|staging|stage|stg|qa|uat|sandbox|preprod|pre-prod)";
const TEST_LABEL = new RegExp(
  `^${TEST_WORD}\\d*$|^${TEST_WORD}-|-${TEST_WORD}\\d*$|^dev\\d+$|-dev\\d*$|^development$`,
  "i"
);
// second-level labels of two-part public suffixes (co.uk, com.bg, ...)
const SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

export function isTestHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const labels = host.split(".");
  const keep = labels.length >= 3 && SLD.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(0, -keep).some((l) => TEST_LABEL.test(l));
}

function quotaLine(r: BraveSearchResponse): string {
  const q = r.quota;
  const parts: string[] = [];
  if (r.cached) parts.push("served from cache (no quota used)");
  if (q) {
    parts.push(
      `Brave quota: ${q.remaining}/${q.limit} searches left this month` +
        (q.resetAt ? ` (resets ${new Date(q.resetAt).toISOString().slice(0, 10)})` : "")
    );
  }
  return parts.length ? `_${parts.join(" · ")}_` : "";
}

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

Queries go through the Brave Search API (free plan: 1 request/second, 2,000/month — shared by every client of the key). Searches are queued to respect the per-second limit, identical searches within 30 minutes are served from cache, and each result shows how many searches are left this month. Be frugal: prefer one well-phrased query and fetching the best results over many reworded searches.

Results on hosts that look like test/staging copies (docs-test., staging., qa., api-dev. ...) are moved to the end and labelled. Query operators work: site:example.com, -site:docs-test.example.com, "exact phrase", -word.

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
                text: `Search error: ${result.error}\n${quotaLine(result)}`.trim(),
              },
            ],
          };
        }

        if (result.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${params.query}". Try broader terms or remove filters.\n${quotaLine(result)}`.trim(),
              },
            ],
          };
        }

        // Format as markdown for readability
        const lines: string[] = [
          `# Search Results: "${result.query}"`,
          `Found ${result.results.length} results`,
          quotaLine(result),
          "",
        ];

        const live = result.results.filter((r) => !isTestHost(r.url));
        const testCopies = result.results.filter((r) => isTestHost(r.url));

        for (let i = 0; i < live.length; i++) {
          const r = live[i];
          lines.push(`## ${i + 1}. ${r.title}`);
          lines.push(`**URL**: ${r.url}`);
          if (r.age) lines.push(`**Age**: ${r.age}`);
          lines.push("");
          lines.push(
            r.description ||
              `_(Brave gave no description for this result. To check it without reading the whole page, use web_fetch with find="<keyword>".)_`
          );
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

        if (testCopies.length) {
          lines.push("## Likely test/staging copies (moved to the end)");
          lines.push(
            "These hosts look like test or staging copies of a site and are often stale. Prefer the live site; exclude one with -site:<host> in the query."
          );
          for (const r of testCopies) lines.push(`- ${r.title} — ${r.url}`);
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
