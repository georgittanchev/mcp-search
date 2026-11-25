// HTML -> markdown for fetched pages.
//
// "main": the page without its chrome. Site menus, headers, footers, cookie
//         banners, sign-up/search forms, breadcrumbs, dialogs and link-dense
//         menu lists are removed; everything else stays (sidebars with facts,
//         reference lists, tables). If the page marks a <main>, only that is
//         used. Deliberately not an "article extractor" (Readability): those
//         pick ONE block and drop the rest, which on reference pages (CVE
//         records, man pages, API docs) loses the part you came for.
// "full": the whole <body>.
//
// turndown's markdown escaping is switched off: the output is read by an LLM,
// not rendered, and "\-W|\--wipesignatures" makes exact option text hard to
// match. Bare <pre> (man pages, terminal output) becomes a fenced block of its
// plain text, so it reads exactly as on screen with no ** inside.

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// @ts-expect-error no type definitions
import { strikethrough, taskListItems } from "turndown-plugin-gfm";

export type ContentMode = "main" | "full";

export interface Converted {
  content: string;
  /** what `content` actually is (main can fall back to full) */
  mode: ContentMode;
  title?: string;
  note?: string;
}

type El = HTMLElement;

// ---------------------------------------------------------------------------
// turndown
// ---------------------------------------------------------------------------

function isLayoutTable(table: El): boolean {
  if (table.querySelector("table")) return true;
  const rows = Array.from((table as HTMLTableElement).rows ?? []);
  if (rows.length === 0) return true;
  const maxCols = Math.max(...rows.map((r) => r.cells.length));
  if (maxCols < 2) return true;
  // cells holding block content (lists, headings, several paragraphs) are layout
  return !!table.querySelector("td ul, td ol, td h1, td h2, td h3, td blockquote, td pre, td p + p");
}

function closestTable(node: Node): El | null {
  let n: Node | null = node.parentNode;
  while (n && n.nodeName !== "TABLE") n = n.parentNode;
  return n as El | null;
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    hr: "---",
  });
  td.escape = (s: string) => s;
  td.use([strikethrough, taskListItems]);
  td.remove(["script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg", "head"] as any);

  // <pre> without <code>: fence its text exactly
  td.addRule("barePre", {
    filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
    replacement: (_content, node) => {
      const text = ((node as El).textContent ?? "").replace(/\n+$/, "");
      const fence = text.includes("```") ? "~~~~" : "```";
      return `\n\n${fence}\n${text}\n${fence}\n\n`;
    },
  });

  // old-style monospace tags (asciidoc output, man2html): inline code
  td.addRule("teletype", {
    filter: (node) => /^(?:TT|KBD|SAMP)$/.test(node.nodeName) && !node.closest?.("pre") && !node.parentNode?.nodeName.match(/^(?:TT|KBD|SAMP|CODE)$/),
    replacement: (content) => (content.trim() ? "`" + content.trim() + "`" : ""),
  });

  // Tables: data tables become pipe tables (first row as header); layout
  // tables are unwrapped into plain blocks instead of being kept as HTML.
  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const table = closestTable(node);
      if (!table || isLayoutTable(table)) return `${content.trim()}\n\n`;
      return ` ${content.trim().replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|")} |`;
    },
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const table = closestTable(node);
      if (!table || isLayoutTable(table)) return content;
      const rows0 = (table as HTMLTableElement).rows;
      if (!content.replace(/[|\s]/g, "") && rows0?.[0] !== node) return ""; // empty row
      let line = `|${content}\n`;
      const rows = (table as HTMLTableElement).rows;
      if (rows && rows[0] === node) {
        const n = (node as HTMLTableRowElement).cells.length;
        line += `|${" --- |".repeat(n)}\n`;
      }
      return line;
    },
  });
  td.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => (content.replace(/[|\s-]/g, "") ? `\n\n${content.trim()}\n\n` : ""),
  });
  td.addRule("caption", {
    filter: "caption",
    replacement: (content) => `${content.trim()}\n\n`,
  });
  return td;
}

const turndown = makeTurndown();

// ---------------------------------------------------------------------------
// main-content cleaning
// ---------------------------------------------------------------------------

const textLen = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().length;

// Always chrome, wherever they are.
// (Not [hidden]: inactive tab/accordion panels often hold real content.)
const CHROME_SELECTORS = [
  "nav", "dialog", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=search]",
  "[role=dialog]", "[role=alertdialog]", "[aria-modal=true]", "select", "input", "textarea",
];

// class/id words that mark chrome
// (word inside a class/id token, e.g. "main-nav", "cookie_banner")
const CHROME_WORD = new RegExp(
  "(?:^|[-_])(?:nav|navbar|navigation|menu|menus|megamenu|breadcrumbs?|cookies?|consent|gdpr|" +
    "newsletter|subscribe|signup|login|social|share|sharing|skip-?link|offcanvas|drawer|modal|popup|" +
    "toast|masthead|toolbar|advert|advertisement|ads|promo|votes?|back-to-top|return-to-top|more-questions|tags|tags-links|post-tags)(?:$|[-_])",
  "i"
);
// whole-token names only: "card-header" is content, "header" / "site-footer" is chrome
const CHROME_TOKEN =
  /^(?:(?:(?:site|page|global|main|top)[-_]?)?(?:header|footer|banner|topbar)|comments|comments-area|comment-respond|article-comments|article-subscribe)$/i;

// sidebars and "related" blocks: removed when they are mostly links
const RELATED_TOKEN =
  /(?:^|[-_])(?:sidebar|related|relatives|recent|recently-viewed|more-articles|popular|trending|read-next|also-like)(?:$|[-_])/i;
const RELATED_HEADING =
  /^(?:articles in this section|in this section|related (?:articles|posts|stories|content|links|reading|topics|questions|pages)|recent(?:ly viewed)? (?:articles|posts|activity)|recent posts|popular (?:articles|posts)|you (?:may|might) also (?:like|be interested)|more (?:articles|from|in this)|read next|trending)\b/i;

function chromeName(el: El): boolean {
  const tokens = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`.split(/\s+/).filter(Boolean);
  return tokens.some((t) => CHROME_TOKEN.test(t) || CHROME_WORD.test(t));
}

function removeIfSmall(el: El, rootText: number, maxShare: number): void {
  // never remove something holding the page heading or most of the text
  if (el.querySelector("h1") || el.tagName === "H1") return;
  if (rootText > 0 && textLen(el) > rootText * maxShare) return;
  el.remove();
}

function hostOf(href: string | null, base: string): string | undefined {
  if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return undefined;
  try {
    return new URL(href, base).hostname;
  } catch {
    return undefined;
  }
}

/** Mostly link text (at least 3 links). */
function linkDense(el: El, share = 0.6): boolean {
  const links = Array.from(el.querySelectorAll("a"));
  if (links.length < 3) return false;
  const total = textLen(el);
  if (total === 0) return true;
  return links.reduce((n, a) => n + textLen(a), 0) / total >= share;
}

/**
 * The element holding the article's paragraphs: the one with the most text in
 * direct <p>/<pre>/<blockquote> children. Lists of links directly inside it
 * (patch downloads, errata, per-CVE plugin pages) are content, not menus.
 */
function articleBody(root: El): El | null {
  let best: El | null = null;
  let bestScore = 0;
  for (const el of [root, ...(Array.from(root.querySelectorAll("*")) as El[])]) {
    let score = 0;
    for (const c of Array.from(el.children)) {
      if (c.tagName === "P" || c.tagName === "PRE" || c.tagName === "BLOCKQUOTE") {
        const n = textLen(c);
        if (n >= 40) score += n;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 300 ? best : null;
}

/** A list introduced by the text before it ("…can be found here:") is content. */
function introduced(el: El): boolean {
  const prev = el.previousElementSibling as El | null;
  if (!prev || /^(?:NAV|UL|OL|A)$/.test(prev.tagName)) return false;
  return /:\s*$/.test((prev.textContent ?? "").trim()) && textLen(prev) >= 15;
}

function inBody(el: El, body: El | null): boolean {
  if (!body) return false;
  const p = el.parentElement;
  return p === body || (p?.parentElement === body && !/^(?:NAV|ASIDE|HEADER|FOOTER)$/.test(p.tagName));
}

/** A list/div that is mostly short links back into the same site: a menu. */
function isMenuBlock(el: El, pageHost: string, base: string): boolean {
  const links = Array.from(el.querySelectorAll("a"));
  if (links.length < 4) return false;
  const total = textLen(el);
  if (total === 0) return true;
  const linkText = links.reduce((n, a) => n + textLen(a), 0);
  if (linkText / total < 0.7) return false;
  if (linkText / links.length > 45) return false; // long link texts: a reading list, not a menu
  const sameSite = links.filter((a) => {
    const h = hostOf(a.getAttribute("href"), base);
    return h === undefined || h === pageHost || h.endsWith("." + pageHost.split(".").slice(-2).join("."));
  }).length;
  return sameSite / links.length >= 0.7;
}

function cleanMain(document: Document, pageUrl: string): El | null {
  const body = document.body as El | null;
  if (!body) return null;

  // a single, substantial <main> is the content
  const mains = Array.from(document.querySelectorAll("main, [role=main]")) as El[];
  let root: El = body;
  if (mains.length === 1 && textLen(mains[0]) >= Math.min(500, textLen(body) * 0.3)) root = mains[0];

  for (const el of Array.from(root.querySelectorAll(CHROME_SELECTORS.join(","))) as El[]) {
    if (el.isConnected) el.remove();
  }

  const rootText = textLen(root);

  // site header/footer: not the ones inside an article (those hold its title/meta)
  for (const el of Array.from(root.querySelectorAll("header, footer")) as El[]) {
    if (!el.isConnected) continue;
    if (el.tagName === "HEADER" && el.closest("article")) continue;
    removeIfSmall(el, rootText, 0.5);
  }

  // forms: sign-up, search and login boxes (a form wrapping the whole page stays)
  for (const el of Array.from(root.querySelectorAll("form")) as El[]) {
    if (el.isConnected && textLen(el) < 1500) removeIfSmall(el, rootText, 0.5);
  }

  // class/id names
  for (const el of Array.from(root.querySelectorAll("[class], [id]")) as El[]) {
    if (!el.isConnected || el === root) continue;
    if (chromeName(el) || el.getAttribute("aria-hidden") === "true") removeIfSmall(el, rootText, 0.3);
  }

  // link-dense menus without semantic markup
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl).hostname;
  } catch {
    /* ignore */
  }
  // sidebars and "related articles" / "articles in this section" blocks
  // (Zendesk help centers: cPanel, CloudLinux, Plesk; most blogs)
  for (const el of Array.from(root.querySelectorAll("aside, [class], [id]")) as El[]) {
    if (!el.isConnected || el === root) continue;
    const tokens = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`.split(/\s+/);
    if ((el.tagName === "ASIDE" || tokens.some((t) => RELATED_TOKEN.test(t))) && linkDense(el)) {
      removeIfSmall(el, rootText, 0.3);
    }
  }
  for (const h of Array.from(root.querySelectorAll("h2, h3, h4, h5, h6")) as El[]) {
    if (!h.isConnected || !RELATED_HEADING.test((h.textContent ?? "").replace(/\s+/g, " ").trim())) continue;
    const box = h.parentElement as El | null;
    if (box && box !== root && box.querySelectorAll("a").length >= 2 && textLen(box) < 3000 && textLen(box) < rootText * 0.3) {
      removeIfSmall(box, rootText, 0.3);
      continue;
    }
    // the heading and what follows it up to the next heading, if that is a short run of links/teasers
    const run: El[] = [];
    let size = 0;
    let links = 0;
    for (let n = h.nextElementSibling as El | null; n && !/^H[1-6]$/.test(n.tagName); n = n.nextElementSibling as El | null) {
      run.push(n);
      size += textLen(n);
      links += n.tagName === "A" ? 1 : n.querySelectorAll("a").length;
    }
    if (run.length && links >= 2 && size < 3000 && !run.some((n) => n.querySelector("h1"))) {
      for (const n of run) n.remove();
      h.remove();
    }
  }

  // link-dense menus without semantic markup (not lists that belong to the article text)
  const textBody = articleBody(root);
  for (const el of Array.from(root.querySelectorAll("ul, ol, div, section, table, p")) as El[]) {
    if (!el.isConnected || el === root) continue;
    if ((el.tagName === "UL" || el.tagName === "OL") && (inBody(el, textBody) || introduced(el))) continue;
    if (isMenuBlock(el, pageHost, pageUrl)) removeIfSmall(el, rootText, 0.3);
  }
  return root;
}

// ---------------------------------------------------------------------------

function titleOf(document: Document): string | undefined {
  const t = document.querySelector("title")?.textContent ?? "";
  // React SSR leaves "<!-- -->" inside <title>, which is raw text there
  return t.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim() || undefined;
}

/** Text-only debris after the content, e.g. a lone "%" a theme prints after a script. */
function trimDebris(md: string): string {
  return md.replace(/(?:\s*\n[ \t]*[^\w\s`~]{1,3}[ \t]*)+\s*$/, "").trimEnd();
}

export function htmlToMarkdown(html: string, mode: ContentMode, pageUrl = "about:blank"): Converted {
  // a fragment without <body> (Proxmox docs pages are served that way) parses
  // into an empty body, so wrap it
  if (!/<body[\s>]/i.test(html)) html = `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const converted = convert(html, mode, pageUrl);
  converted.content = trimDebris(converted.content);
  return converted;
}

function convert(html: string, mode: ContentMode, pageUrl: string): Converted {
  const { document } = parseHTML(html) as unknown as { document: Document };
  const title = titleOf(document);
  if (mode === "full") {
    return { content: turndown.turndown((document.body as El | null)?.innerHTML ?? html), mode: "full", title };
  }
  const fullText = textLen(document.body);
  const root = cleanMain(document, pageUrl);
  if (!root || textLen(root) < Math.min(200, fullText * 0.5)) {
    const again = parseHTML(html) as unknown as { document: Document };
    return {
      content: turndown.turndown((again.document.body as El | null)?.innerHTML ?? html),
      mode: "full",
      title,
      note: "Removing the menus left almost nothing, so this is the whole page.",
    };
  }
  return { content: turndown.turndown(root.innerHTML), mode: "main", title };
}

/** Bytes -> string, honouring the charset from the header or a <meta> tag. */
export function decodeBody(buf: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset && /html|xml/i.test(contentType)) {
    const head = buf.subarray(0, 4096).toString("latin1");
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
