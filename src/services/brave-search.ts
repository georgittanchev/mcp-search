import { BRAVE_API_BASE, DEFAULT_TIMEOUT_MS } from "../constants.js";
import {
  BraveQuota,
  BraveQuotaError,
  getBraveQuota,
  recordBraveHeaders,
  reserveBraveSlot,
} from "./brave-limiter.js";
import { htmlSnippetToText } from "./text.js";

// ---------------------------------------------------------------------------
// Types for Brave Search API response
// ---------------------------------------------------------------------------

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  language?: string;
  extra_snippets?: string[];
}

export interface BraveSearchResponse {
  query: string;
  results: BraveSearchResult[];
  total_estimated: number;
  error?: string;
  /** true when served from cache (no quota spent) */
  cached?: boolean;
  quota?: BraveQuota;
}

// Raw API shapes (subset of what Brave returns)
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  language?: string;
  extra_snippets?: string[];
}

interface BraveApiResponse {
  query?: { original?: string };
  web?: { results?: BraveWebResult[] };
  mixed?: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    throw new Error(
      "BRAVE_API_KEY environment variable is required. Get one at https://api-dashboard.search.brave.com/"
    );
  }
  return key;
}

// Identical searches within this window are answered from memory: the free
// plan has 2,000 requests a month, and models often repeat a query.
const CACHE_TTL_MS = Number(process.env.BRAVE_CACHE_TTL_MS || 30 * 60_000);
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; value: BraveSearchResponse }>();

function cacheGet(key: string): BraveSearchResponse | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: BraveSearchResponse): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value as string);
  }
}

/**
 * Brave descriptions are HTML fragments (<strong>, &#x27;). Some are only a
 * URL, or start with one ("https://github.com/... ... Malicious code"): drop
 * the URL; a description with nothing left becomes "".
 */
function cleanDescription(html: string): string {
  let d = htmlSnippetToText(html).replace(/\s+/g, " ").trim();
  d = d.replace(/^(?:https?:\/\/|www\.)\S+\s*(?:\.\.\.|…)?\s*/i, "");
  return /[\p{L}\p{N}]{2}/u.test(d) && d.length >= 12 ? d : "";
}

function fail(query: string, error: string, quota?: BraveQuota): BraveSearchResponse {
  return { query, results: [], total_estimated: 0, error, quota };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function braveSearch(
  query: string,
  count: number = 10,
  offset: number = 0,
  country?: string,
  searchLang?: string,
  freshness?: string
): Promise<BraveSearchResponse> {
  const apiKey = getApiKey();

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)), // Brave max is 20
    // more snippets per result on plans that include them (ignored otherwise)
    extra_snippets: "true",
  });

  if (offset > 0) params.set("offset", String(offset));
  if (country) params.set("country", country);
  if (searchLang) params.set("search_lang", searchLang);
  if (freshness) params.set("freshness", freshness); // pd, pw, pm, py, YYYY-MM-DDtoYYYY-MM-DD

  const cacheKey = params.toString();
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, cached: true, quota: await getBraveQuota().catch(() => cached.quota) };
  }

  const url = `${BRAVE_API_BASE}?${params.toString()}`;

  // One retry: a 429 for the per-second window means another client of the
  // same key slipped in between; the monthly window is checked before retrying.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await reserveBraveSlot();
    } catch (err: unknown) {
      const quota = await getBraveQuota().catch(() => undefined);
      return fail(query, err instanceof Error ? err.message : String(err), quota);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        signal: controller.signal,
      });

      await recordBraveHeaders(resp.headers).catch((e) =>
        console.error("[web-tools-mcp] could not record Brave rate-limit headers:", e)
      );

      if (resp.status === 429) {
        const quota = await getBraveQuota().catch(() => undefined);
        if (quota && quota.remaining <= 0) {
          const err = new BraveQuotaError(
            `Brave Search monthly quota is used up (${quota.limit}/month).` +
              (quota.resetAt ? ` It resets ${new Date(quota.resetAt).toISOString().slice(0, 10)}.` : "")
          );
          return fail(query, err.message, quota);
        }
        if (attempt === 0) continue; // per-second collision: take a new slot
      }

      if (!resp.ok) {
        const body = await resp.text();
        return fail(
          query,
          `Brave API returned ${resp.status}: ${body.slice(0, 500)}`,
          await getBraveQuota().catch(() => undefined)
        );
      }

      const data = (await resp.json()) as BraveApiResponse;
      const webResults = data.web?.results ?? [];

      const value: BraveSearchResponse = {
        query: data.query?.original ?? query,
        results: webResults.map((r: BraveWebResult) => {
          const extra = (r.extra_snippets ?? []).map(htmlSnippetToText).filter(Boolean);
          return {
            title: htmlSnippetToText(r.title ?? ""),
            url: r.url ?? "",
            description: cleanDescription(r.description ?? ""),
            ...(r.age ? { age: r.age } : {}),
            ...(r.language ? { language: r.language } : {}),
            ...(extra.length ? { extra_snippets: extra } : {}),
          };
        }),
        total_estimated: webResults.length,
      };
      cacheSet(cacheKey, value);
      return { ...value, quota: await getBraveQuota().catch(() => undefined) };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return fail(query, `Brave API request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      return fail(
        query,
        `Brave API request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return fail(query, "Brave API kept answering 429 (rate limited). Try again in a few seconds.");
}
