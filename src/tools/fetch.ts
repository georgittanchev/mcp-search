import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ContentMode, fetchUrl, FetchResult } from "../services/fetcher.js";
import { findInContent, matchSections, outlineOf, SectionMatch } from "../services/find.js";
import { BULK_CHAR_BUDGET, FETCH_CHAR_BUDGET } from "../constants.js";

const MAX_CHARS_CEILING = 150_000;

const findSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .optional()
  .describe(
    'Return only the parts of the page that mention this text (or any of up to 10 strings), with `context` paragraphs around each match — e.g. find="--wipesignatures" or find=["-W", "--zero"]. Case-insensitive unless the term has a capital letter; markdown formatting (**, `, \\) is ignored when matching. Wrap a term in slashes for a regular expression: find="/CVE-2026-\\d+/" or "/--zero\\b/" (the text is matched with whitespace, line breaks included, collapsed to single spaces).'
  );
const sectionSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .optional()
  .describe(
    'Return whole sections of the page by heading: every section whose heading contains this text, up to the next heading of the same level — e.g. section="Configuration" or section="Has Tenable released". Bold-only lines (FAQ questions) count as headings. With find as well, find searches only inside those sections. Not sure of the heading? Use outline=true first.'
  );
const contextSchema = z
  .number()
  .int()
  .min(0)
  .max(10)
  .default(1)
  .describe("With find: paragraphs to include before and after each match (default 1).");
const contentSchema = z
  .enum(["main", "full"])
  .optional()
  .describe(
    '"main" (default for public pages): the page without site menus, headers, footers, cookie banners and sign-up/search forms. "full" (default for localhost/dev servers): the whole page as markdown.'
  );

const WebFetchInputSchema = z.object({
  url: z
    .string()
    .url("Must be a valid URL with scheme (e.g., https://example.com)")
    .describe("Full URL to fetch, must include https:// or http://"),
  find: findSchema,
  context: contextSchema,
  section: sectionSchema,
  outline: z
    .boolean()
    .optional()
    .describe("true: return only the page's table of contents (headings with start_index offsets and sizes), to pick a section to read. Cheap: a few hundred chars."),
  content: contentSchema,
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Character offset to start from. Use the value given at the end of a truncated result to read the next part. With find: search from this offset on."
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(MAX_CHARS_CEILING)
    .default(FETCH_CHAR_BUDGET)
    .describe(`Maximum characters of page content to return in this call (default ${FETCH_CHAR_BUDGET}).`),
});

const WebBulkFetchInputSchema = z.object({
  urls: z
    .array(z.string().url("Each URL must include https:// or http://"))
    .min(3, "Pass at least 3 URLs (use web_fetch for one or two pages)")
    .max(10, "Maximum 10 URLs per batch")
    .describe("3 to 10 URLs to fetch, in parallel"),
  find: findSchema,
  context: contextSchema,
  content: contentSchema,
  max_total_chars: z
    .number()
    .int()
    .min(10_000)
    .max(MAX_CHARS_CEILING)
    .default(BULK_CHAR_BUDGET)
    .describe(`Total characters of page content across all pages in this call (default ${BULK_CHAR_BUDGET}). Short pages come back whole; their unused share goes to the longer ones.`),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;
type WebBulkFetchInput = z.infer<typeof WebBulkFetchInputSchema>;

function failureText(url: string, result: FetchResult): string | undefined {
  if (result.error) return `FAILED: ${url}\nError: ${result.error}`;
  if (!result.ok) {
    const note = result.note ? `Note: ${result.note}\n` : "";
    return `FAILED: ${url}\n${note}HTTP ${result.status} (via ${result.source})\n\n${result.content.slice(0, 1500)}`;
  }
  return undefined;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 1 ? "under a minute ago" : `${min} min ago`;
}

function metaLine(result: FetchResult, extra: string[]): string {
  const via = result.cached
    ? `${result.source} (stored copy fetched ${ago(Date.now() - (result.fetchedAt ?? Date.now()))})`
    : `${result.source} (fresh)`;
  let content: string;
  if (result.mode === "main") {
    content =
      `main — menus/headers/footers/forms removed` +
      (result.fullLength ? `, ${result.content.length} of ${result.fullLength} chars` : "") +
      `; content="full" for the whole page`;
  } else if (result.mode === "full") content = "full page";
  else content = `document (${result.contentType})`;
  const parts = [
    `URL: ${result.url}`,
    ...(result.title ? [`Title: ${result.title}`] : []),
    `Status: ${result.status}`,
    `Via: ${via}`,
    `Content: ${content}`,
    ...extra,
  ];
  return parts.join(" | ") + (result.note ? `\nNote: ${result.note}` : "");
}

function callHint(url: string, mode: ContentMode | undefined, args: Record<string, unknown>): string {
  const all: Record<string, unknown> = { url, ...(mode === "full" ? { content: "full" } : {}), ...args };
  return Object.entries(all)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
}

/** content.slice(from, to), with code fences closed/reopened where the slice cuts through a block. */
function fencedSlice(content: string, from: number, to: number): string {
  const fencesIn = (t: string) => (t.match(/^(?:```|~~~~)/gm) ?? []).length;
  const before = fencesIn(content.slice(0, from)) % 2 === 1;
  let body = content.slice(from, to);
  if (before) body = "```\n" + body;
  if ((fencesIn(content.slice(0, from)) + fencesIn(content.slice(from, to))) % 2 === 1) body += "\n```";
  return body;
}

/** Page content from `start`, at most `limit` chars, with a continuation hint. */
function formatSlice(url: string, result: FetchResult, mode: ContentMode | undefined, start: number, limit: number): string {
  const total = result.content.length;
  const from = Math.min(start, total);
  const to = Math.min(total, from + limit);
  const size = from === 0 && to === total ? `Size: ${total} chars (complete)` : `Showing chars ${from}-${to} of ${total}`;
  let text = `${metaLine(result, [size])}\n\n${fencedSlice(result.content, from, to)}`;
  if (to < total) {
    text +=
      `\n\n[TRUNCATED — ${total - to} chars remain. To continue, call web_fetch with ${callHint(url, mode, { start_index: to })}. ` +
      `That reads the same copy, at no extra cost. To jump to one topic, use find="<keyword>" or section="<heading>" instead (outline=true lists the headings).]`;
  }
  return text;
}

function termsOf(find: string | string[]): string[] {
  return Array.isArray(find) ? find : [find];
}

/**
 * Run `pick` on the content; if it finds nothing in the main content, run it on
 * the whole page (same stored copy) too, in case the cleaner removed that part.
 */
async function withFullFallback<T>(
  url: string,
  first: FetchResult,
  mode: ContentMode | undefined,
  pick: (content: string) => T | undefined
): Promise<{ result: FetchResult; usedMode: ContentMode | undefined; value: T | undefined; widened: boolean }> {
  const value = pick(first.content);
  if (value !== undefined || first.mode !== "main") return { result: first, usedMode: mode, value, widened: false };
  const full = await fetchUrl(url, { mode: "full", reuse: true });
  if (!failureText(url, full)) {
    const v2 = pick(full.content);
    if (v2 !== undefined) return { result: full, usedMode: "full", value: v2, widened: true };
  }
  return { result: first, usedMode: mode, value: undefined, widened: false };
}

const WIDENED = `No match in the main content; this is from the whole page (offsets refer to content="full").`;
const quoteList = (xs: string[]) => xs.map((t) => JSON.stringify(t)).join(", ");
const one = <T>(xs: T[]): T | T[] => (xs.length === 1 ? xs[0] : xs);

function formatOutline(result: FetchResult): string {
  const outline = outlineOf(result.content, 150);
  const head = metaLine(result, [`Outline (page is ${result.content.length} chars)`]);
  if (!outline) {
    return `${head}\n\nThis page has no headings. Use find="<keyword>" to jump to a topic, or read it in parts with start_index.`;
  }
  return (
    `${head}\n\n${outline}\n\n` +
    `[Read a section with section="<heading text>", or from an offset with start_index=<n>. find="<keyword>" searches the whole page.]`
  );
}

/** section: whole sections by heading (optionally narrowed with find). */
async function formatSections(
  url: string,
  first: FetchResult,
  mode: ContentMode | undefined,
  names: string[],
  find: string[] | undefined,
  context: number,
  start: number,
  budget: number
): Promise<string> {
  const { result, usedMode, value, widened } = await withFullFallback(url, first, mode, (content) => {
    const m = matchSections(content, names);
    return m.matches.length ? m : undefined;
  });
  if (!value) {
    const outline = outlineOf(result.content, 100);
    return (
      `${metaLine(result, [`section ${quoteList(names)}: no heading matches`])}\n\n` +
      (outline
        ? `The page's headings (use one of these with section=, or start_index=<offset>):\n${outline}`
        : `This page has no headings. Use find="<keyword>" instead.`)
    );
  }
  const secs = value.matches.filter((m) => m.end > start);
  const label = (m: SectionMatch) => JSON.stringify(m.heading.text);

  if (find) {
    return formatFind(url, result, usedMode, find, context, start, budget, {
      ranges: secs.map((m) => [m.start, m.end] as [number, number]),
      scope: `in section${secs.length === 1 ? "" : "s"} ${secs.map(label).join(", ")}`,
      section: names,
      widened,
    });
  }

  const total = secs.reduce((n, m) => n + m.end - Math.max(m.start, start), 0);
  let text = metaLine(result, [
    `section ${quoteList(names)}: ${secs.length} section${secs.length === 1 ? "" : "s"}, ${total} chars (page is ${result.content.length} chars)`,
  ]);
  if (widened) text += `\n${WIDENED}`;
  if (value.missing.length) text += `\nNo heading matches: ${quoteList(value.missing)}`;

  const parts: string[] = [];
  let used = 0;
  let more = "";
  for (let i = 0; i < secs.length; i++) {
    const m = secs[i];
    const from = Math.max(m.start, start);
    const header = `── [${i + 1}] ${label(m)} · chars ${from}-${m.end} ──`;
    const len = m.end - from;
    const room = budget - used - header.length - 2;
    if (len <= room) {
      const body = fencedSlice(result.content, from, m.end).trim();
      parts.push(`${header}\n${body}`);
      used += header.length + body.length + 2;
      continue;
    }
    if (parts.length === 0) {
      // cut at a line break when there is one near the limit
      let cutAt = from + Math.max(0, room - 10);
      const nl = result.content.lastIndexOf("\n", cutAt);
      if (nl > from + room * 0.8) cutAt = nl;
      parts.push(`${header}\n${fencedSlice(result.content, from, cutAt).trim()}`);
      more =
        `[SECTION CUT — ${m.end - cutAt} chars of it remain. To continue, call web_fetch with ` +
        `${callHint(url, usedMode, { section: one(names), start_index: cutAt })}.]`;
    } else {
      more =
        `[MORE — ${secs.length - i} more section${secs.length - i === 1 ? "" : "s"} not shown (${secs.slice(i).map(label).join(", ")}). ` +
        `To read on, call web_fetch with ${callHint(url, usedMode, { section: one(names), start_index: m.start })}.]`;
    }
    break;
  }
  text += `\n\n${parts.join("\n\n")}`;
  if (more) text += `\n\n${more}`;
  return text;
}

/**
 * find: matching sections only. If nothing matches in the main content, the
 * whole page (same stored copy) is searched too, in case the cleaner removed it.
 */
async function formatFind(
  url: string,
  first: FetchResult,
  mode: ContentMode | undefined,
  terms: string[],
  context: number,
  start: number,
  budget: number,
  within?: { ranges: [number, number][]; scope: string; section: string[]; widened: boolean }
): Promise<string> {
  let result = first;
  let usedMode: ContentMode | undefined = mode;
  let found = findInContent(result.content, terms, { context, from: start, budget, ranges: within?.ranges });
  let widened = within?.widened ? WIDENED : "";
  if (!within) {
    const r = await withFullFallback(url, first, mode, (content) => {
      const f = findInContent(content, terms, { context, from: start, budget });
      return f.matches ? f : undefined;
    });
    if (r.value) {
      result = r.result;
      usedMode = r.usedMode;
      found = r.value;
      if (r.widened) widened = WIDENED;
    }
  }
  const extra = within ? { section: one(within.section) } : {};

  const termText = terms.map((t) => JSON.stringify(t)).join(", ");
  const summary =
    found.matches === 0
      ? `find ${termText}${within ? ` ${within.scope}` : ""}: no match${within ? "" : ` in ${result.content.length - start} chars`}`
      : `find ${termText}${within ? ` ${within.scope}` : ""}: ${found.matches} match${found.matches === 1 ? "" : "es"} in ${found.sections} section${found.sections === 1 ? "" : "s"} (page is ${result.content.length} chars)`;
  let text = metaLine(result, [summary]);
  if (widened) text += `\n${widened}`;
  if (found.matches && found.missing.length) {
    text += `\nNo match for: ${found.missing.map((t) => JSON.stringify(t)).join(", ")}`;
  }

  if (found.matches === 0) {
    text += `\n\nNothing on the page matches. Try a shorter or different term (e.g. one word of a phrase, or the option name without its value).`;
    if (found.outline && !within) text += `\n\nThe page's headings (read one with section="<heading>" or start_index=<offset>):\n${found.outline}`;
    return text;
  }

  text += `\n\n${found.text}`;
  if (found.nextStart !== undefined) {
    const left = found.sections - found.shownSections;
    text +=
      `\n\n[MORE — ${left > 0 ? `${left} more section${left === 1 ? "" : "s"} not shown` : "section cut"} (max_chars). ` +
      `To see the rest, call web_fetch with ${callHint(url, usedMode, { ...extra, find: one(terms), start_index: found.nextStart })}, ` +
      `or use a more specific term.]`;
  } else {
    text += `\n\n[End of matches. To read on from one, call web_fetch with ${callHint(url, usedMode, {})} start_index=<the section's start offset>.]`;
  }
  return text;
}

/** Split `budget` so short pages get all they need and long pages share the rest evenly. */
function allocate(lengths: number[], budget: number): number[] {
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  const out = new Array<number>(lengths.length).fill(0);
  let left = budget;
  let k = order.length;
  for (const { len, i } of order) {
    const share = Math.floor(left / k);
    out[i] = Math.min(len, share);
    left -= out[i];
    k--;
  }
  return out;
}

const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

export function registerFetchTool(server: McpServer): void {
  server.registerTool(
    "web_fetch",
    {
      title: "Web Fetch",
      description: `Fetch one web page and return it as markdown, through BrightData Web Unlocker (renders JavaScript, gets past bot blocks and CAPTCHAs). By default only the page's main content comes back: site menus, headers, footers, cookie banners and sign-up/search forms are removed (content="full" for everything). Links are absolute; text is not markdown-escaped, so option names and commands appear exactly as on the page. BrightData reports most pages as status 200 even when the site served a 404, so judge "page not found" from the content.

Reading only part of a page (cheaper than the whole page; find/section/outline calls on a page fetched in the last 15 minutes reuse that copy, no new fetch):
  - find="<text>": only the paragraphs around each match — what a flag does, a version number, a config key. Several terms: find=["-W", "--zero"]. Regex: find="/CVE-\\d{4}-\\d+/".
  - section="<heading>": whole sections by heading text, e.g. section="Configuration". Add find to search only inside them.
  - outline=true: the page's headings with offsets and sizes, to choose what to read.

Long pages come back in chunks (default ${FETCH_CHAR_BUDGET} chars): if a result ends with [TRUNCATED ...], call again with the given start_index. Continuing reuses the copy fetched for the first part.

Every new read without find or start_index fetches the live page. For 3-10 pages at once, use web_bulk_fetch.

Args:
  - url (string, required): Full URL with https:// or http://.
  - find (string or string[], optional): Return only the paragraphs mentioning this text (/regex/ allowed).
  - section (string or string[], optional): Return whole sections whose heading contains this text.
  - outline (boolean, optional): Return only the page's headings.
  - context (optional): With find, paragraphs around each match (default 1).
  - content (optional): "main" (default) or "full".
  - start_index (optional): Character offset to continue reading (or to search from, with find).
  - max_chars (optional): Characters to return in this call (default ${FETCH_CHAR_BUDGET}).`,
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
        const mode = params.content;
        const result = await fetchUrl(params.url, {
          mode,
          reuse: params.start_index > 0 || params.find !== undefined || params.section !== undefined || !!params.outline,
        });
        const failed = failureText(params.url, result);
        if (failed) return errorResult(failed);
        const text = params.outline
          ? formatOutline(result)
          : params.section
            ? await formatSections(
                params.url,
                result,
                mode,
                termsOf(params.section),
                params.find ? termsOf(params.find) : undefined,
                params.context,
                params.start_index,
                params.max_chars
              )
            : params.find
              ? await formatFind(params.url, result, mode, termsOf(params.find), params.context, params.start_index, params.max_chars)
              : formatSlice(params.url, result, mode, params.start_index, params.max_chars);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: unknown) {
        return errorResult(`web_fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.registerTool(
    "web_bulk_fetch",
    {
      title: "Web Bulk Fetch",
      description: `Fetch 3 to 10 web pages in parallel, in a single call. Use it after web_search to read the most promising results together.

Each page is returned as markdown through BrightData Web Unlocker (JavaScript rendered), by default main content only (no site menus, headers, footers or sign-up forms; content="full" for whole pages). The response has a shared size budget (default ${BULK_CHAR_BUDGET} chars): short pages come back complete and long pages split what is left. Any page that doesn't fit ends with [TRUNCATED ...] and a start_index — read the rest with web_fetch (continuing reuses this copy, at no extra cost).

With find="<text>" (or a list), each page returns only the sections mentioning it — the way to compare one fact across several pages.

Args:
  - urls (string[], required): 3-10 URLs, each with https:// or http://.
  - find (string or string[], optional): Only the sections mentioning this text, per page.
  - context (optional): With find, paragraphs around each match (default 1).
  - content (optional): "main" (default) or "full".
  - max_total_chars (optional): Total characters across all pages (default ${BULK_CHAR_BUDGET}, max ${MAX_CHARS_CEILING}).`,
      inputSchema: WebBulkFetchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: WebBulkFetchInput) => {
      const urls = [...new Set(params.urls)];
      const mode = params.content;
      const reuse = params.find !== undefined;

      const settled = await Promise.allSettled(urls.map((url) => fetchUrl(url, { mode, reuse })));
      const results: FetchResult[] = settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : {
              ok: false,
              status: 0,
              url: urls[i],
              content: "",
              contentType: "",
              source: "brightdata" as const,
              error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            }
      );

      let failedCount = 0;
      let truncatedCount = 0;
      const header = (i: number) => `\n${"=".repeat(80)}\n# [${i + 1}/${urls.length}] ${urls[i]}\n${"=".repeat(80)}`;

      let sections: string[];
      if (params.find) {
        // find on every page with the full budget, then share the budget by result size
        const terms = termsOf(params.find);
        const found = await Promise.all(
          results.map((r, i) =>
            failureText(urls[i], r)
              ? Promise.resolve(undefined)
              : formatFind(urls[i], r, mode, terms, params.context, 0, params.max_total_chars)
          )
        );
        const budgets = allocate(found.map((f) => f?.length ?? 0), params.max_total_chars);
        sections = results.map((r, i) => {
          const f = found[i];
          if (f === undefined) {
            failedCount++;
            return `${header(i)}\n${failureText(urls[i], r)}`;
          }
          if (f.length <= budgets[i]) return `${header(i)}\n${f}`;
          truncatedCount++;
          return `${header(i)}\n${f.slice(0, budgets[i])}\n\n[CUT to fit — repeat with web_fetch url=${JSON.stringify(urls[i])} find=${JSON.stringify(params.find)} to see all matches on this page.]`;
        });
      } else {
        const okLengths = results.map((r) => (failureText(r.url, r) ? 0 : r.content.length));
        const budgets = allocate(okLengths, params.max_total_chars);
        sections = results.map((r, i) => {
          const failed = failureText(urls[i], r);
          if (failed) {
            failedCount++;
            return `${header(i)}\n${failed}`;
          }
          if (budgets[i] < r.content.length) truncatedCount++;
          return `${header(i)}\n${formatSlice(urls[i], r, mode, 0, budgets[i])}`;
        });
      }

      const summary =
        `Fetched ${urls.length} URLs | ` +
        `${urls.length - failedCount} ok, ${failedCount} failed` +
        (truncatedCount
          ? ` | ${truncatedCount} cut to fit — continue them with web_fetch`
          : " | all complete");

      return {
        isError: failedCount === urls.length,
        content: [{ type: "text" as const, text: `${summary}\n${sections.join("\n")}` }],
      };
    }
  );
}
