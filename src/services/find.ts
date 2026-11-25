// "find" for web_fetch: return only the paragraphs around a keyword instead of
// the whole page. Typical use: "what does --wipesignatures do" on a man page.

/** A paragraph (or a piece of a very long one) of the page, as char offsets. */
interface Unit {
  start: number;
  end: number;
}

// Paragraphs longer than this are split into line groups, so one match in a
// huge block (a long list, a <pre> without blank lines) doesn't return all of it.
const MAX_UNIT = 1200;
const PIECE = 800;

function segment(text: string): Unit[] {
  const units: Unit[] = [];
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) units.push({ start: s, end: e });
  };
  const addPara = (s: number, e: number) => {
    if (e - s <= MAX_UNIT) return push(s, e);
    // group whole lines up to PIECE chars; a single over-long line is cut at whitespace
    let groupStart = s;
    let pos = s;
    while (pos < e) {
      let nl = text.indexOf("\n", pos);
      if (nl === -1 || nl > e) nl = e;
      if (nl - groupStart > PIECE && pos > groupStart) {
        push(groupStart, pos);
        groupStart = pos;
      }
      if (nl - groupStart > MAX_UNIT) {
        // over-long line: cut it into PIECE-sized windows at spaces
        while (nl - groupStart > MAX_UNIT) {
          let cut = text.lastIndexOf(" ", groupStart + PIECE);
          if (cut <= groupStart) cut = groupStart + PIECE;
          push(groupStart, cut);
          groupStart = cut;
        }
      }
      pos = nl + 1;
    }
    push(groupStart, e);
  };
  const re = /\n[ \t]*\n\s*/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    addPara(pos, m.index);
    pos = m.index + m[0].length;
  }
  addPara(pos, text.length);
  return units;
}

/**
 * Text as compared by find: markdown emphasis/code/escape characters removed,
 * typographic hyphens made ASCII, man-page line-break hyphenation joined and
 * whitespace collapsed. So "--wipesignatures" matches "**\--wipesignatures**".
 */
function normalize(s: string): string {
  return s
    .replace(/[‐­]\s*\n\s*/g, "") // "wipe_signa‐\n   tures"
    .replace(/[‐‑−]/g, "-")
    .replace(/[*`\\]/g, "")
    .replace(/\s+/g, " ");
}

function countIn(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

interface Needle {
  term: string;
  /** plain text (normalized, lower-cased unless case-sensitive) */
  n: string;
  sensitive: boolean;
  re?: RegExp;
}

/**
 * Plain text, or /regex/flags. Smart case for both: case-sensitive only if the
 * term has an uppercase letter (for a regex: outside escapes like \S, \W).
 */
function makeNeedle(term: string): Needle {
  const rx = /^\/(.+)\/([a-z]*)$/s.exec(term.trim());
  if (rx) {
    const flags = rx[2].replace(/[^imsu]/g, "");
    const pattern = rx[1];
    const bare = pattern.replace(/\\./g, "");
    const sensitive = !flags.includes("i") && bare !== bare.toLowerCase();
    try {
      const re = new RegExp(pattern, "g" + flags + (sensitive || flags.includes("i") ? "" : "i"));
      return { term, n: pattern, sensitive, re };
    } catch {
      /* not a valid regex: search it as text */
    }
  }
  const n = normalize(term).trim();
  const sensitive = n !== n.toLowerCase();
  return { term, n: sensitive ? n : n.toLowerCase(), sensitive };
}

/** Occurrences of a needle in already-normalized text. */
function countNeedle(nd: Needle, norm: string): number {
  if (nd.re) {
    let c = 0;
    for (const m of norm.matchAll(nd.re)) if (m[0].length) c++;
    return c;
  }
  if (!nd.n) return 0;
  return countIn(nd.sensitive ? norm : norm.toLowerCase(), nd.n);
}

function cleanHeading(line: string): string {
  return line
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export interface Heading {
  pos: number;
  /** 1-6 for markdown headings, 7 for a line that is only bold text (FAQ questions, term lists) */
  level: number;
  text: string;
}

/** Markdown headings (and bold-only lines) outside code blocks, in page order. */
export function headingsOf(content: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let fence = "";
  let pos = 0;
  for (const line of content.split("\n")) {
    const f = /^(```|~~~~)/.exec(line);
    if (f && (!inFence || f[1] === fence)) {
      inFence = !inFence;
      fence = f[1];
    } else if (!inFence) {
      const h = /^(#{1,6})[ \t]+\S/.exec(line);
      if (h) {
        const text = cleanHeading(line);
        if (text) out.push({ pos, level: h[1].length, text });
      } else {
        // a paragraph that is only bold text: "**Has Tenable released any product coverage?**"
        const b = /^\*\*([^*\n][^\n]{0,150}?)\*\*:?\s*$/.exec(line);
        // (short ones like "**CVE**" are table labels, not headings)
        if (b && !b[1].includes("**") && (b[1].length >= 15 || /\?\s*$/.test(b[1]))) {
          const text = cleanHeading(b[1]).replace(/:$/, "");
          if (text) out.push({ pos, level: 7, text });
        }
      }
    }
    pos += line.length + 1;
  }
  return out;
}

/** End of the section a heading starts: the next heading of the same or a higher level. */
function sectionEnd(headings: Heading[], i: number, contentLength: number): number {
  for (let k = i + 1; k < headings.length; k++) if (headings[k].level <= headings[i].level) return headings[k].pos;
  return contentLength;
}

const kchars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`) + " chars";

/** The page's headings with offsets and section sizes, indented by level. */
export function outlineOf(content: string, max = 120): string | undefined {
  const all = headingsOf(content);
  if (!all.length) return undefined;
  const sized = all.map((h, i) => ({ ...h, size: sectionEnd(all, i, content.length) - h.pos }));
  let shown = sized;
  // too many: drop bold-only lines, then the deepest heading level, until it fits
  let cut = 7;
  while (shown.length > max && cut > 1) {
    shown = sized.filter((h) => h.level < cut);
    cut--;
  }
  if (shown.length > max) shown = shown.slice(0, max);
  const levels = [...new Set(shown.filter((h) => h.level < 7).map((h) => h.level))].sort();
  let depth = 0;
  const lines = shown.map((h) => {
    if (h.level < 7) depth = levels.indexOf(h.level);
    const d = h.level < 7 ? depth : depth + 1;
    return `${"  ".repeat(d)}- ${h.text}  (start_index=${h.pos}, ${kchars(h.size)})`;
  });
  const hidden = all.length - shown.length;
  if (hidden > 0) lines.push(`(${hidden} lower-level headings not listed)`);
  return lines.join("\n");
}

export interface SectionMatch {
  heading: Heading;
  start: number;
  end: number;
}

/** Sections whose heading contains one of `names` (same matching rules as find). */
export function matchSections(content: string, names: string[]): { matches: SectionMatch[]; missing: string[] } {
  const headings = headingsOf(content);
  const needles = names.map(makeNeedle);
  const matches: SectionMatch[] = [];
  const hitBy = new Array<number>(names.length).fill(0);
  headings.forEach((h, i) => {
    const norm = normalize(h.text);
    let any = false;
    needles.forEach((nd, k) => {
      if (countNeedle(nd, norm)) {
        hitBy[k]++;
        any = true;
      }
    });
    if (!any) return;
    const m = { heading: h, start: h.pos, end: sectionEnd(headings, i, content.length) };
    // a section inside one already matched adds nothing
    if (!matches.some((x) => m.start >= x.start && m.end <= x.end)) matches.push(m);
  });
  return { matches, missing: names.filter((_, k) => hitBy[k] === 0) };
}

export interface FindResult {
  /** formatted sections, ready to return */
  text: string;
  matches: number;
  sections: number;
  shownSections: number;
  /** terms that matched nothing */
  missing: string[];
  /** where to continue (start_index) when the budget ran out */
  nextStart?: number;
  /** headings of the page with offsets, when nothing matched */
  outline?: string;
}

export function findInContent(
  content: string,
  terms: string[],
  opts: { context: number; from: number; budget: number; ranges?: [number, number][] }
): FindResult {
  const needles = terms.map(makeNeedle);

  // only inside the given ranges (sections), if any
  const units = segment(content).filter(
    (u) => !opts.ranges || opts.ranges.some(([a, b]) => u.start < b && u.end > a)
  );
  const perTerm = new Array<number>(needles.length).fill(0);
  const hit: number[] = [];
  let matches = 0;
  units.forEach((u, idx) => {
    if (u.end <= opts.from) return;
    const norm = normalize(content.slice(Math.max(u.start, opts.from), u.end));
    let any = false;
    needles.forEach((nd, k) => {
      const c = countNeedle(nd, norm);
      if (c) {
        perTerm[k] += c;
        matches += c;
        any = true;
      }
    });
    if (any) hit.push(idx);
  });

  const missing = needles.filter((_, k) => perTerm[k] === 0).map((nd) => nd.term);

  const headings = headingsOf(content);
  const headingBefore = (pos: number) => {
    let h: string | undefined;
    for (const x of headings) {
      if (x.pos > pos) break;
      if (x.level < 7) h = x.text;
    }
    return h;
  };

  if (hit.length === 0) {
    return { text: "", matches: 0, sections: 0, shownSections: 0, missing, outline: outlineOf(content, 60) };
  }

  // matched units ± context, merged where they touch
  const ranges: [number, number][] = [];
  for (const idx of hit) {
    const a = Math.max(0, idx - opts.context);
    const b = Math.min(units.length - 1, idx + opts.context);
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }

  // fence lines, to keep each section's code blocks balanced
  const fences: number[] = [];
  for (const m of content.matchAll(/^(?:```|~~~~)/gm)) fences.push(m.index!);
  const fencesBefore = (pos: number) => {
    let n = 0;
    for (const f of fences) {
      if (f >= pos) break;
      n++;
    }
    return n;
  };
  /** close/open fences so a slice starting or ending inside a code block reads right */
  const balance = (start: number, end: number, body: string) => {
    let out = body;
    if (fencesBefore(start) % 2 === 1) {
      // starts inside a block: drop a leading closing fence, or open one
      out = /^(?:```|~~~~)[ \t]*\n/.test(out) ? out.replace(/^(?:```|~~~~)[ \t]*\n/, "") : "```\n" + out;
    }
    if (fencesBefore(end) % 2 === 1) out = out.replace(/\n(?:```|~~~~)[^\n]*$/, "") + "\n```";
    return out;
  };

  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  let nextStart: number | undefined;
  for (const [a, b] of ranges) {
    const start = Math.max(units[a].start, a === hit[0] ? opts.from : 0);
    const end = units[b].end;
    const h = headingBefore(start);
    const header = `── [${shown + 1}] chars ${start}-${end}${h ? ` · under "${h}"` : ""} ──`;
    let body = balance(start, end, content.slice(start, end));
    const cost = header.length + body.length + 2;
    if (used + cost > opts.budget) {
      if (shown > 0) {
        nextStart = start;
        break;
      }
      // the first section alone is over budget: show what fits
      body = body.slice(0, Math.max(0, opts.budget - header.length - 2));
      nextStart = start + body.length;
      parts.push(`${header}\n${body}`);
      shown++;
      break;
    }
    parts.push(`${header}\n${body}`);
    used += cost;
    shown++;
  }

  return {
    text: parts.join("\n\n"),
    matches,
    sections: ranges.length,
    shownSections: shown,
    missing,
    nextStart,
  };
}
