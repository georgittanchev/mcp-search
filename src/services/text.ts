// Small text helpers shared by search and fetch.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
  times: "×", divide: "÷", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

/** Decode HTML entities: named (common set), decimal (&#39;) and hex (&#x27;). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[ref.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Brave snippets are HTML fragments: <strong> around the query words and
 * entity-escaped text (&lt;file&gt;, &#x27;). Tags are dropped BEFORE decoding,
 * so an escaped "&lt;file&gt;" survives as literal "<file>".
 */
export function htmlSnippetToText(html: string): string {
  return decodeEntities(html.replace(/<\/?[a-z][^<>]*>/gi, ""));
}
