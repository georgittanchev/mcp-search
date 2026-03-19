import {
  getRandomUserAgent,
  getBrowserHeaders,
  DEFAULT_TIMEOUT_MS,
  JINA_TIMEOUT_MS,
  JINA_READER_BASE,
  CHARACTER_LIMIT,
  FetchStrategy,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

function getProxyUrl(): string | undefined {
  return (
    process.env.PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    undefined
  );
}

function getJinaApiKey(): string | undefined {
  return process.env.JINA_API_KEY || undefined;
}

// ---------------------------------------------------------------------------
// Proxy-aware fetch helper
//
// We dynamically import undici's ProxyAgent only when a proxy is configured.
// This avoids hard-coupling to undici at the module level and keeps the server
// working even in environments where undici isn't readily importable (the
// global fetch still works fine without a dispatcher).
// ---------------------------------------------------------------------------

interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
}

async function proxyFetch(
  url: string,
  opts: FetchOptions = {}
): Promise<Response> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, method = "GET", body } = opts;
  const proxyUrl = getProxyUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts: RequestInit & { dispatcher?: unknown } = {
      method,
      headers,
      signal: controller.signal,
      redirect: "follow",
    };
    if (body) fetchOpts.body = body;

    if (proxyUrl) {
      try {
        // undici is bundled with Node 18+ but the import path varies
        const undici = await import("undici");
        const ProxyAgent = undici.ProxyAgent;
        fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
      } catch {
        // If undici import fails, log and continue without proxy
        console.error(
          "[web-tools-mcp] Warning: PROXY_URL is set but undici ProxyAgent could not be loaded. Fetching without proxy."
        );
      }
    }

    return await fetch(url, fetchOpts as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  content: string;
  contentType: string;
  strategy: string; // which strategy was actually used
  error?: string;
}

/**
 * Direct fetch with rotating user agent + optional proxy.
 * Returns raw HTML/text.
 */
async function fetchDirect(url: string): Promise<FetchResult> {
  const ua = getRandomUserAgent();
  const headers = getBrowserHeaders(ua);

  const resp = await proxyFetch(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
  const contentType = resp.headers.get("content-type") || "text/html";
  const text = await resp.text();

  return {
    ok: resp.ok,
    status: resp.status,
    url: resp.url, // final URL after redirects
    content: text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) + `\n\n[TRUNCATED — original size: ${text.length} chars]`
      : text,
    contentType,
    strategy: "direct",
  };
}

/**
 * Fetch via Jina Reader API — returns clean markdown.
 * Handles JS rendering server-side, bypasses many anti-bot measures.
 */
async function fetchJina(url: string): Promise<FetchResult> {
  const jinaUrl = `${JINA_READER_BASE}/${url}`;
  const headers: Record<string, string> = {
    Accept: "text/markdown",
    "X-Return-Format": "markdown",
  };

  const jinaKey = getJinaApiKey();
  if (jinaKey) {
    headers["Authorization"] = `Bearer ${jinaKey}`;
  }

  // Jina doesn't need proxy or UA rotation — it fetches on their infra
  const resp = await proxyFetch(jinaUrl, {
    headers,
    timeoutMs: JINA_TIMEOUT_MS,
  });

  const contentType = resp.headers.get("content-type") || "text/markdown";
  const text = await resp.text();

  return {
    ok: resp.ok,
    status: resp.status,
    url,
    content: text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) + `\n\n[TRUNCATED — original size: ${text.length} chars]`
      : text,
    contentType,
    strategy: "jina",
  };
}

/**
 * Main fetch entry point.
 *
 * Strategy:
 *   - "direct": only direct fetch (with UA rotation + proxy)
 *   - "jina": only Jina Reader
 *   - "auto" (default): try direct first, fall back to Jina on failure
 */
export async function fetchUrl(
  url: string,
  strategy: FetchStrategy = FetchStrategy.AUTO
): Promise<FetchResult> {
  if (strategy === FetchStrategy.JINA) {
    return fetchJina(url);
  }

  if (strategy === FetchStrategy.DIRECT) {
    return fetchDirect(url);
  }

  // AUTO: try direct, fall back to jina
  try {
    const result = await fetchDirect(url);
    if (result.ok) return result;

    // If we got a block/bot-detection page (403, 429, 503, captcha indicators)
    if ([403, 429, 451, 503].includes(result.status) || isBlockPage(result.content)) {
      console.error(
        `[web-tools-mcp] Direct fetch returned ${result.status} for ${url}, falling back to Jina Reader`
      );
      try {
        const jinaResult = await fetchJina(url);
        if (jinaResult.ok) return jinaResult;
      } catch {
        // Jina also failed — return original direct result
      }
    }
    return result;
  } catch (directErr: unknown) {
    // Direct fetch threw (timeout, DNS, network error)
    console.error(
      `[web-tools-mcp] Direct fetch failed for ${url}: ${directErr instanceof Error ? directErr.message : directErr}. Falling back to Jina.`
    );
    try {
      return await fetchJina(url);
    } catch (jinaErr: unknown) {
      return {
        ok: false,
        status: 0,
        url,
        content: "",
        contentType: "",
        strategy: "auto",
        error: `Both direct and Jina fetch failed. Direct: ${directErr instanceof Error ? directErr.message : directErr}. Jina: ${jinaErr instanceof Error ? jinaErr.message : jinaErr}`,
      };
    }
  }
}

/**
 * Simple heuristic to detect if a response body looks like a bot-block page.
 */
function isBlockPage(html: string): boolean {
  const lower = html.toLowerCase();
  const indicators = [
    "captcha",
    "challenge-platform",
    "cf-browser-verification",
    "access denied",
    "blocked",
    "rate limit",
    "are you a robot",
    "please verify",
    "cloudflare",
    "ddos-guard",
    "distil_r_captcha",
    "px-captcha",
  ];
  // If it's a very short page with block indicators, it's probably a block
  const hasIndicator = indicators.some((i) => lower.includes(i));
  return hasIndicator && html.length < 50_000;
}
