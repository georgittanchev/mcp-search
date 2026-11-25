// Request configuration
export const DEFAULT_TIMEOUT_MS = 30_000;
// Hard ceiling on one page held in memory (the tools return it in chunks)
export const MAX_PAGE_CHARS = 2_000_000;
// How much page text one tool call returns. Kept well under what MCP clients
// shows inline (bigger results get saved to a file and must be dug out with a
// script): 35k chars ≈ 9-12k tokens of English, more for Cyrillic.
export const FETCH_CHAR_BUDGET = Number(process.env.FETCH_CHAR_BUDGET || 35_000);
export const BULK_CHAR_BUDGET = Number(process.env.BULK_CHAR_BUDGET || 40_000);
export const BRAVE_API_BASE = "https://api.search.brave.com/res/v1/web/search";
// BrightData Web Unlocker: the only fetcher for public pages (markdown output)
export const BRIGHTDATA_API_URL = "https://api.brightdata.com/request";
export const BRIGHTDATA_TIMEOUT_MS = 60_000;
// First attempt + one retry must answer before Cloudflare's 100s origin timeout
export const FETCH_DEADLINE_MS = 95_000;
// Plain fetch of localhost / private hosts (local stdio mode only)
export const LOCAL_TIMEOUT_MS = 30_000;
