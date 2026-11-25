# web-tools-mcp-server

An MCP server that gives an LLM two things it is usually bad at: searching the web and reading pages that block bots.

- `web_search` — Brave Search API.
- `web_fetch` / `web_bulk_fetch` — pages fetched through **BrightData Web Unlocker** (gets past bot blocks, CAPTCHAs and IP bans), converted locally to clean markdown. Main content only by default, with `find`, `section` and `outline` so the model can pull just the part it needs instead of a 200k-character page.

I built it because the built-in fetch tools of AI coding assistants kept failing on exactly the pages I needed (vendor docs behind Cloudflare, CVE pages, hosting control-panel knowledge bases), and when they did work they returned menus, cookie banners and "related articles" instead of the content.

## What's different

- **Reads what humans read.** BrightData returns raw HTML; this server strips navigation, headers, footers, sidebars, sign-up forms, cookie banners, link-dense "related" blocks and comment widgets, but never the element holding the `h1` or most of the text. Data tables become pipe tables, `<pre>` blocks stay exact, man-page options like `-W|--wipesignatures` are not mangled by markdown escaping.
- **Asks for less.** `find="--some-flag"` returns only the paragraphs mentioning it, each with its offset and heading. `section="Configuration"` returns whole sections. `outline=true` returns just the headings. One fetch, many cheap lookups: a page snapshot is kept for 15 minutes only for these follow-ups.
- **Shares one Brave key safely.** Every local client session spawns its own copy of the server, and the HTTP connector runs alongside them. The free-plan limits (1 request/second, 2,000/month) are enforced across all of them through a lock-guarded state file, synced with Brave's `X-RateLimit-*` headers. Identical searches are cached for 30 minutes, and every result says how many searches are left this month.
- **Safe as a public connector.** In HTTP mode an SSRF guard refuses loopback, private, link-local, CGNAT and multicast targets, checked on the address the socket actually connects to (no DNS-rebinding bypass) and on every redirect hop.
- **PDFs** come back as text (`pdftotext -layout`, pages marked). Charset is detected from headers or `<meta charset>` (windows-1251 pages work).
- **Staging hosts** in search results (`staging.`, `docs-test.`, `qa.`, `api-dev.`) are moved below the live results and labelled.

## Requirements

- Node.js 18+
- A [Brave Search API](https://api-dashboard.search.brave.com/) key (the free plan works)
- A [BrightData](https://brightdata.com/) API key with a Web Unlocker zone. Without it, `web_fetch` only works for local URLs.
- Optional: `poppler-utils` for PDF text extraction

## Install

```bash
git clone https://github.com/georgittanchev/mcp-search.git web-tools-mcp-server
cd web-tools-mcp-server
npm ci
npm run build
cp .env.example .env   # then fill in the keys
```

## Use it locally (stdio)

Add it to your MCP client's config. Keys can live in the server's own `.env` (recommended, so they are not copied into every client config) or in the `env` block:

```json
{
  "mcpServers": {
    "web-tools": {
      "command": "node",
      "args": ["/path/to/web-tools-mcp-server/dist/index.js"]
    }
  }
}
```

In stdio mode, local URLs (`localhost`, `*.local`, private IPs) get a plain HTTP fetch, so you can point it at your own dev servers. They default to `content: "full"`, since forms and navigation are usually what you are checking there.

## Run it as a remote connector (HTTP)

`dist/http.js` serves the same tools over streamable HTTP at:

```
https://your-domain/search-mcp/<MCP_SECRET>
```

- The secret in the path is the credential. Every other path returns 404, so nobody without the link can tell the endpoint exists. It must be at least 24 characters (`openssl rand -hex 24`); to rotate it, change `MCP_SECRET`, restart and re-add the connector.
- Stateless JSON responses (no SSE stream), one fresh server per request. That keeps it simple behind Cloudflare and reverse proxies that buffer.
- It binds to `127.0.0.1:6014` by default. Put your web server in front of it as a reverse proxy for `/search-mcp/`.
- A pm2 example is in `ecosystem.config.example.cjs`:

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
pm2 start ecosystem.config.cjs
```

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `BRAVE_API_KEY` | Yes | Brave Search API key |
| `BRIGHTDATA_API_KEY` | Yes | BrightData API key |
| `BRIGHTDATA_ZONE` | No | Web Unlocker zone (default `web_unlocker2`) |
| `FETCH_CHAR_BUDGET` | No | Default `max_chars` of `web_fetch` (35000) |
| `BULK_CHAR_BUDGET` | No | Default `max_total_chars` of `web_bulk_fetch` (40000) |
| `PDFTOTEXT` | No | Path of `pdftotext` (default `/usr/bin/pdftotext`) |
| `BRAVE_MONTHLY_LIMIT`, `BRAVE_MIN_INTERVAL_MS` | No | Brave plan limits (2000 / 1100 ms) |
| `MCP_SECRET`, `PORT`, `BIND_HOST`, `BASE_PATH`, `BLOCK_PRIVATE_ADDRESSES` | HTTP only | Connector settings. The stdio entry point ignores them. |

The HTTP entry point lets `.env` override the shell environment on purpose (login shells often export stale keys and `HOSTNAME`). The stdio entry point lets values from the client config win.

## Tools

### `web_search`

`query` (required), `count` (1–20, default 10), `offset`, `country`, `search_lang`, `freshness` (`pd`/`pw`/`pm`/`py` or `YYYY-MM-DDtoYYYY-MM-DD`). Titles and descriptions come back as plain text with HTML entities decoded.

### `web_fetch`

- `url` (required)
- `find`: a string or up to 10 strings. Returns only the paragraphs mentioning them, each with a `chars a-b` offset and the heading it sits under. Smart case (case-sensitive only if the term has a capital letter), or a regular expression written `/pattern/flags`. Matching ignores markdown and collapses whitespace. If nothing matches, the page's headings are listed.
- `section`: a string or up to 10 strings. Returns whole sections whose heading contains one of them. A bold-only paragraph (FAQ questions) counts as a heading. With `find` too, `find` searches only inside those sections.
- `outline`: `true` returns only the headings with their offsets and sizes.
- `context`: with `find`, paragraphs before and after each match (default 1, max 10)
- `content`: `"main"` (default for public pages) or `"full"` (default for local URLs)
- `start_index`: continue a long page from this offset
- `max_chars`: characters to return (default 35000)

### `web_bulk_fetch`

`urls` (3–10, fetched in parallel), plus `find`, `context` and `content` as above, applied to every page. `max_total_chars` is a shared budget (default 40000): short pages come back whole and long pages split the rest.

## How fetching works

- **Public URLs** make one `POST https://api.brightdata.com/request` with `format: "raw"` and convert the HTML here.
  - If the HTML is an empty JavaScript-app shell, it is fetched once more with BrightData's browser rendering (slower, capped at 45 s).
  - Transient BrightData errors (5xx, 429, `x-brd-error`, network) are retried once, inside a 95 s deadline so the whole call answers before a 100 s proxy timeout (Cloudflare's default). Timeouts are not retried.
  - **BrightData reports 200 even when the site returned 404.** Judge "not found" from the content.
- **Local URLs** get a plain fetch in stdio mode and are refused in HTTP mode (`BLOCK_PRIVATE_ADDRESSES=true`).
- **No page cache** for new reads: every new read is live. Snapshots exist only for `start_index` continuation and `find`/`section`/`outline` follow-ups within 15 minutes, so the parts line up and BrightData isn't billed again per chunk.

### Why the size limits

`web_fetch` returns at most 35k characters per call and `web_bulk_fetch` 40k in total. Larger tool results tend to get saved to a file by the client instead of shown to the model, which then has to dig the relevant part out with a script. A truncated page says which `start_index` continues it, and suggests `find`.

## Changelog

- **1.3.0** — Fetching moved to BrightData Web Unlocker with local HTML→markdown conversion (main-content extraction, `find`, `section`, `outline`), `web_bulk_fetch`, PDF support, HTTP connector entry point with SSRF guard, cross-process Brave rate limiter. The Jina Reader fallback and user-agent rotation from 1.0 were removed. Old `strategy` / `mode` arguments are still accepted and ignored.
- **1.0.0** — Brave search, direct fetch with user-agent rotation and Jina Reader fallback.

## License

MIT — see [LICENSE](LICENSE).

## Author

Georgi Tanchev — https://tanchev.net
