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
        const undici = await import("undici");
        const ProxyAgent = undici.ProxyAgent;
        fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
      } catch {
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
  strategy: string;
  error?: string;
}

async function fetchDirect(url: string): Promise<FetchResult> {
  const ua = getRandomUserAgent();
  const headers = getBrowserHeaders(ua);

  const resp = await proxyFetch(url, { headers, timeoutMs: DEFAULT_TIMEOUT_MS });
  const contentType = resp.headers.get("content-type") || "text/html";
  const raw = await resp.text();

  // Strip HTML junk for text/html responses, leave JSON/XML/plain text as-is
  const isHtml = contentType.includes("text/html");
  const text = isHtml ? stripHtmlJunk(raw) : raw;

  return {
    ok: resp.ok,
    status: resp.status,
    url: resp.url,
    content: text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) + `\n\n[TRUNCATED — original size: ${text.length} chars]`
      : text,
    contentType,
    strategy: "direct",
  };
}

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

  // AUTO: try Jina first (clean markdown), fall back to direct
  try {
    const jinaResult = await fetchJina(url);
    if (jinaResult.ok) return jinaResult;
    console.error(
      `[web-tools-mcp] Jina returned ${jinaResult.status} for ${url}, falling back to direct fetch`
    );
  } catch (jinaErr: unknown) {
    console.error(
      `[web-tools-mcp] Jina failed for ${url}: ${jinaErr instanceof Error ? jinaErr.message : jinaErr}. Falling back to direct fetch.`
    );
  }

  try {
    return await fetchDirect(url);
  } catch (directErr: unknown) {
    return {
      ok: false,
      status: 0,
      url,
      content: "",
      contentType: "",
      strategy: "auto",
      error: `Both Jina and direct fetch failed for ${url}.`,
    };
  }
}

/**
 * Strip HTML junk that wastes tokens: <head>, <script>, <style>, <noscript>,
 * <nav>, <footer>, <svg>, HTML comments, and collapse excessive whitespace.
 * Only applied to HTML content from direct fetches (Jina already returns clean markdown).
 */
function stripHtmlJunk(html: string): string {
  let cleaned = html;
  // Remove entire tag blocks (with content) that are never useful
  const stripTags = [
    "head", "script", "style", "noscript", "svg", "nav", "footer",
    "header", "iframe", "object", "embed",
  ];
  for (const tag of stripTags) {
    cleaned = cleaned.replace(
      new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"),
      ""
    );
    // Self-closing variants
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
  }
  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  // Remove all remaining HTML tags, keep text content
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace: multiple spaces/tabs to single space, multiple newlines to double
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, "\n\n");
  return cleaned.trim();
}

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
  const hasIndicator = indicators.some((i) => lower.includes(i));
  return hasIndicator && html.length < 50_000;
}
