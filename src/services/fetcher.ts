import { fetch as undiciFetch } from "undici";
import {
  BRIGHTDATA_API_URL,
  BRIGHTDATA_TIMEOUT_MS,
  FETCH_DEADLINE_MS,
  LOCAL_TIMEOUT_MS,
  MAX_PAGE_CHARS,
} from "../constants.js";
import { assertPublicUrl, BLOCK_PRIVATE, directAgent, isLocalUrl } from "./net-guard.js";
import { ContentMode, decodeBody, htmlToMarkdown } from "./convert.js";
import { isPdf, pdfToText } from "./pdf.js";

// ---------------------------------------------------------------------------
// Every public page is fetched through BrightData Web Unlocker
// (https://docs.brightdata.com/scraping-automation/web-unlocker): it renders
// JavaScript and gets past bot blocks/CAPTCHAs. We take the HTML and convert
// it here (convert.ts): "main" = the page without menus/headers/footers/forms,
// "full" = the whole page. An empty JS-app shell is retried once with
// BrightData's browser rendering. PDFs go through pdftotext (pdf.ts); text
// formats (JSON, plain text, XML) come back as they are.
//
// The only other path: in local stdio mode (BLOCK_PRIVATE_ADDRESSES off),
// localhost / private-IP URLs get a plain HTTP fetch, because BrightData
// cannot reach this machine's dev servers.
// ---------------------------------------------------------------------------

function getBrightData(): { key: string; zone: string } | undefined {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) return undefined;
  return { key, zone: process.env.BRIGHTDATA_ZONE || "web_unlocker2" };
}

export function brightDataConfigured(): boolean {
  return getBrightData() !== undefined;
}

export type { ContentMode };

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  content: string;
  contentType: string;
  source: "brightdata" | "local";
  /** what `content` is: main content, whole page, or a non-HTML document as text */
  mode?: ContentMode | "document";
  title?: string;
  /** length of the whole-page markdown, when `content` is the main content */
  fullLength?: number;
  error?: string;
  /** true when this is a stored copy (continued read or find) */
  cached?: boolean;
  fetchedAt?: number;
  note?: string;
}

/** One fetched page; converted lazily per mode. */
interface Page {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  source: "brightdata" | "local";
  fetchedAt: number;
  html?: string;
  /** non-HTML body already as text/markdown */
  text?: string;
  note?: string;
  converted: Partial<Record<ContentMode, { content: string; mode: ContentMode; title?: string; note?: string }>>;
}

// No caching of page content for new reads: every one goes to the live site.
// A SNAPSHOT of each successful fetch is kept for continuing the same page
// (start_index > 0) and for find, so parts line up (same copy) and BrightData
// isn't billed again for every chunk or keyword.
const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 15 * 60_000);
const SNAPSHOT_MAX = 40;
const MAX_HTML_CHARS = 5_000_000;
const RENDER_TIMEOUT_MS = 45_000;
const snapshots = new Map<string, Page>();

function snapshotGet(key: string): Page | undefined {
  const hit = snapshots.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.fetchedAt > SNAPSHOT_TTL_MS) {
    snapshots.delete(key);
    return undefined;
  }
  return hit;
}

function snapshotSet(key: string, value: Page): void {
  snapshots.delete(key);
  snapshots.set(key, value);
  while (snapshots.size > SNAPSHOT_MAX) {
    snapshots.delete(snapshots.keys().next().value as string);
  }
}

function capSize(text: string): string {
  return text.length > MAX_PAGE_CHARS
    ? text.slice(0, MAX_PAGE_CHARS) + `\n\n[CUT — page exceeds ${MAX_PAGE_CHARS} chars]`
    : text;
}

/**
 * Markdown clean-up: resolve relative hrefs against the page URL (the model
 * can't follow "](/global/x)"), drop data: images, alt-less images and empty
 * anchor links, merge "**-W**|**--wipe**" into "**-W|--wipe**", and collapse
 * blank-line runs. Fenced code blocks are left alone.
 */
function tidyMarkdown(md: string, pageUrl: string): string {
  return md
    .split(/(^(?:```|~~~~)[\s\S]*?^(?:```|~~~~))/m)
    .map((part, i) => (i % 2 ? part : tidyProse(part, pageUrl)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tidyProse(text: string, pageUrl: string): string {
  let out = text
    .replace(/!\[([^\]\n]*)\]\(data:[^)]*\)/g, (_m, alt) => (alt ? `[image: ${alt}]` : ""))
    .replace(/!\[\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "")
    // "[](#NAME)" anchors carry no text
    .replace(/(?<!!)\[\]\([^)\s]*\)/g, "")
    // "[top](#top_of_page)", "[Back to top](#)" jump links
    .replace(/[ \t]*\[(?:\^|↑|top|back to top|return to top|go to top)\]\(#[^)\s]*\)/gi, "")
    // Wikipedia/MediaWiki "[edit]" section links
    .replace(/[ \t]*\[\[edit\]\([^)\s]*(?:\s+"[^"]*")?\)\]/g, "")
    // placeholder avatars
    .replace(/!\[(?:user )?avatar\]\([^)]*\)/gi, "")
    // "](href" — matching the closing half handles links that wrap an image: [![logo](a.svg)](/)
    .replace(/\]\(([^)\s]+)/g, (whole, href: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return whole;
      try {
        return "](" + new URL(href, pageUrl).toString();
      } catch {
        return whole;
      }
    })
    // link text spread over lines by block elements inside <a>
    .replace(/\[([^\[\]\n]{0,200}\n[^\[\]]{0,200})\]\(/g, (_m, t: string) => `[${t.replace(/\s+/g, " ").trim()}](`)
    // "[https://x](https://x)" says it twice
    .replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, "$1")
    .replace(/[ \t\u00a0]+\n/g, "\n");
  // bold runs split only by a separator: "**-W**|**--wipesignatures y**|**n**"
  // (not on table rows, where "|" separates cells)
  out = out.replace(/^(?!\s*\|).*$/gm, (line) => line.replace(/\*\*([|,/=])\*\*/g, "$1"));
  return out;
}

class BrightDataError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "BrightDataError";
  }
}

function isHtml(contentType: string, body: string): boolean {
  if (/html|xhtml/i.test(contentType)) return true;
  if (contentType && !/text\/plain|octet-stream/i.test(contentType)) return false;
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(body.slice(0, 1000));
}

function isTextual(contentType: string): boolean {
  return /^text\/|json|xml|javascript|yaml|csv|markdown/i.test(contentType);
}

/** One BrightData request. Throws BrightDataError for BrightData-side failures. */
async function brightDataOnce(url: string, timeoutMs: number, opts: { render?: boolean } = {}): Promise<Page> {
  const bd = getBrightData();
  if (!bd) throw new BrightDataError("BrightData is not configured (BRIGHTDATA_API_KEY missing)", false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(BRIGHTDATA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bd.key}` },
      body: JSON.stringify({
        zone: bd.zone,
        url,
        format: "raw",
        ...(opts.render ? { render: "true" } : {}),
      }),
      signal: controller.signal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    // The API answers 200 for the request itself; the target's status is in
    // x-brd-status-code and BrightData's own failures in x-brd-error.
    const brdError = resp.headers.get("x-brd-error");
    if (!resp.ok || brdError) {
      const reason = brdError || buf.subarray(0, 300).toString("utf8").trim() || `HTTP ${resp.status}`;
      // 4xx from the API itself (bad key, zone, quota) won't fix itself on retry
      const retryable = resp.status >= 500 || resp.status === 429 || (resp.ok && !!brdError);
      throw new BrightDataError(`BrightData failed: ${reason}`, retryable);
    }
    const status = Number(resp.headers.get("x-brd-status-code")) || resp.status;
    const contentType = resp.headers.get("content-type") || "";
    const page: Page = {
      ok: status >= 200 && status < 400 && buf.length > 0,
      status,
      url,
      contentType: contentType || "text/html",
      source: "brightdata",
      fetchedAt: Date.now(),
      converted: {},
      ...(buf.length === 0 ? { note: "BrightData returned an empty page" } : {}),
    };
    await fillBody(page, buf);
    return page;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new BrightDataError(`BrightData timed out after ${Math.round(timeoutMs / 1000)}s`, false);
    }
    if (err instanceof BrightDataError) throw err;
    throw new BrightDataError(`BrightData request failed: ${errMessage(err)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** BrightData with one retry for transient BrightData-side errors, inside one deadline. */
async function fetchBrightData(url: string): Promise<Page> {
  assertPublicUrl(url);
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  let page: Page;
  try {
    page = await brightDataOnce(url, Math.min(BRIGHTDATA_TIMEOUT_MS, FETCH_DEADLINE_MS));
  } catch (err: unknown) {
    const left = deadline - Date.now();
    if (!(err instanceof BrightDataError) || !err.retryable || left < 15_000) throw err;
    console.error(`[web-tools-mcp] ${err.message} for ${url}, retrying once`);
    try {
      page = await brightDataOnce(url, left - 2_000);
    } catch (err2: unknown) {
      throw new Error(`${err.message}; retry: ${errMessage(err2)}`);
    }
  }
  // An empty JavaScript-app shell (<div id="root"></div> + scripts): BrightData
  // didn't run the page. Ask once more with a real browser (slower).
  if (page.ok && page.html !== undefined && looksLikeShell(page.html)) {
    const left = deadline - Date.now();
    if (left > 20_000) {
      console.error(`[web-tools-mcp] ${url} came back as an empty JS shell, retrying with render`);
      try {
        // capped: browser rendering is slow and this is a best-effort extra
        const rendered = await brightDataOnce(url, Math.min(left - 2_000, RENDER_TIMEOUT_MS), { render: true });
        if (rendered.ok && rendered.html !== undefined) {
          if (looksLikeShell(rendered.html)) {
            rendered.note =
              "The page builds its content with JavaScript after loading (e.g. from an API) and still had almost no text after browser rendering. Try another source for the same information.";
          }
          return rendered;
        }
      } catch (err) {
        console.error(`[web-tools-mcp] render retry failed for ${url}: ${errMessage(err)}`);
      }
    }
  }
  return page;
}

/** Visible text of an HTML page is (nearly) empty but it has scripts. */
function looksLikeShell(html: string): boolean {
  if (!/<script/i.test(html)) return false;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|noscript|template|svg)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length < 200;
}

/** Put the response body on the page: HTML to convert, text as is, PDF via pdftotext. */
async function fillBody(page: Page, buf: Buffer): Promise<void> {
  const ct = page.contentType;
  if (isPdf(ct, buf)) {
    try {
      page.text = capSize(await pdfToText(buf));
      page.note = "PDF, text extracted with pdftotext (layout kept; page breaks marked).";
    } catch (err) {
      page.ok = false;
      page.note = `Could not extract the PDF's text: ${errMessage(err)}`;
    }
    return;
  }
  if (!isTextual(ct) && ct && !/octet-stream/i.test(ct)) {
    page.ok = false;
    page.note = `This is a binary ${ct.split(";")[0]} file, which can't be read as text.`;
    return;
  }
  const body = decodeBody(buf, ct);
  if (isHtml(ct, body)) page.html = body.slice(0, MAX_HTML_CHARS);
  else if (/\u0000/.test(body.slice(0, 2000))) {
    page.ok = false;
    page.note = "This is a binary file, which can't be read as text.";
  } else page.text = capSize(body);
}

/** Plain HTTP fetch for localhost / private hosts (local stdio mode only). */
async function fetchLocal(url: string): Promise<Page> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    const resp = await undiciFetch(url, {
      headers: { "User-Agent": "web-tools-mcp (local)" },
      signal: controller.signal,
      dispatcher: directAgent,
    });
    const contentType = resp.headers.get("content-type") || "text/html";
    const page: Page = {
      ok: resp.ok,
      status: resp.status,
      url: resp.url || url,
      contentType,
      source: "local",
      fetchedAt: Date.now(),
      converted: {},
    };
    await fillBody(page, Buffer.from(await resp.arrayBuffer()));
    return page;
  } finally {
    clearTimeout(timer);
  }
}

/** undici wraps the real reason ("fetch failed") — surface the cause. */
function errMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
}

function convertPage(page: Page, mode: ContentMode) {
  const hit = page.converted[mode];
  if (hit) return hit;
  let out;
  try {
    const c = htmlToMarkdown(page.html!, mode, page.url);
    out = { ...c, content: capSize(tidyMarkdown(c.content, page.url)) };
  } catch (err) {
    console.error(`[web-tools-mcp] converting ${page.url} failed:`, err);
    out = { content: "", mode, note: `Converting the page to markdown failed: ${errMessage(err)}` };
  }
  page.converted[mode] = out;
  // main fell back to the whole page: that IS the full conversion
  if (mode === "main" && out.mode === "full" && !page.converted.full) page.converted.full = out;
  return out;
}

function toResult(page: Page, mode: ContentMode, cached: boolean): FetchResult {
  const base = {
    status: page.status,
    url: page.url,
    contentType: page.contentType,
    source: page.source,
    fetchedAt: page.fetchedAt,
    ...(cached ? { cached: true } : {}),
  };
  if (page.html === undefined) {
    const content = page.text ?? "";
    return {
      ...base,
      ok: page.ok && content.length > 0,
      content,
      mode: "document",
      ...(page.note || !content ? { note: page.note ?? "The page is empty" } : {}),
    };
  }
  const c = convertPage(page, mode);
  const fullLength = c.mode === "main" ? convertPage(page, "full").content.length : undefined;
  const notes = [page.note, c.note].filter(Boolean).join(" ");
  return {
    ...base,
    ok: page.ok && c.content.length > 0,
    content: c.content,
    mode: c.mode,
    ...(c.title ? { title: c.title } : {}),
    ...(fullLength !== undefined ? { fullLength } : {}),
    ...(notes || !c.content ? { note: notes || "The page converted to nothing (no text)" } : {}),
  };
}

/**
 * Fetch a page. `reuse` = continuing a read or searching it: take the copy
 * fetched in the last 15 minutes if there is one. A new read is always live.
 */
export async function fetchUrl(
  url: string,
  opts: { mode?: ContentMode; reuse?: boolean } = {}
): Promise<FetchResult> {
  const local = !BLOCK_PRIVATE && isLocalUrl(url);
  // local dev servers: forms and navigation are what you're usually checking
  const mode = opts.mode ?? (local ? "full" : "main");
  if (opts.reuse) {
    const hit = snapshotGet(url);
    if (hit) return toResult(hit, mode, true);
  }
  let page: Page;
  try {
    page = local ? await fetchLocal(url) : await fetchBrightData(url);
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      url,
      content: "",
      contentType: "",
      source: local ? "local" : "brightdata",
      error: errMessage(err),
    };
  }
  const result = toResult(page, mode, false);
  if (result.ok) snapshotSet(url, page);
  return result;
}
