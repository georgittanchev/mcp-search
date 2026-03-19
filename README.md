# web-tools-mcp-server

Drop-in MCP replacement for Claude's native `web_search` and `web_fetch` tools. Solves the "failed to fetch" / "failed to crawl" errors caused by IP blocks and user-agent detection on Claude's default infrastructure.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     web-tools-mcp-server                         │
│                                                                  │
│  web_search ──────► Brave Search API ($5/1k queries)             │
│                     Your own API key = your own IP = no blocks   │
│                                                                  │
│  web_fetch  ──────► Strategy: AUTO (default)                     │
│                     │                                            │
│                     ├─ 1. Direct fetch                           │
│                     │   • Rotating real-browser User-Agents      │
│                     │   • Full browser headers (Sec-Ch-Ua, etc.) │
│                     │   • Optional proxy (Bright Data / any)     │
│                     │                                            │
│                     └─ 2. Jina Reader fallback (on 403/429/503)  │
│                        • Server-side JS rendering                │
│                        • Returns clean LLM-ready markdown        │
│                        • Free tier (no key needed)               │
└──────────────────────────────────────────────────────────────────┘
```

## Why this beats native tools

| Problem with native tools | How this MCP fixes it |
|---|---|
| Claude's IP is known and blocked by many sites | Your proxy IP (Bright Data residential) or at minimum your own server's IP |
| Claude's user agent is detected as a bot | Rotates through 12+ real browser UAs with matching Sec-Ch-Ua headers |
| JS-heavy sites return empty content | Jina Reader renders JS server-side, returns clean markdown |
| "Failed to fetch" with no fallback | Auto strategy tries direct → falls back to Jina automatically |
| Search results may be limited | Brave's 35B+ page index, you control the API key |

## Prerequisites

- **Node.js 18+**
- **Brave Search API key** — [Get one here](https://api-dashboard.search.brave.com/) ($5 free credit/month)
- **Optional**: Jina API key for higher rate limits — [Get one here](https://jina.ai/) (free tier works without key)
- **Optional**: Proxy URL (Bright Data, or any HTTP/SOCKS5 proxy)

## Installation

```bash
# Clone or copy this directory
cd web-tools-mcp-server

# Install dependencies
npm install

# Build
npm run build

# Verify it compiled
ls dist/index.js
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BRAVE_API_KEY` | **Yes** | Brave Search API subscription token |
| `PROXY_URL` | No | Proxy URL for direct fetches. Format: `http://user:pass@host:port` or `socks5://user:pass@host:port` |
| `JINA_API_KEY` | No | Jina Reader API key for higher rate limits. Free tier works without it. |
| `HTTP_PROXY` | No | Alternative to PROXY_URL (standard env var) |
| `HTTPS_PROXY` | No | Alternative to PROXY_URL (standard env var) |

### Bright Data proxy example

```bash
export PROXY_URL="http://brd-customer-XXXXX-zone-XXXXX:PASSWORD@brd.superproxy.io:22225"
```

### Bright Data with residential IPs (best anti-detection)

```bash
export PROXY_URL="http://brd-customer-XXXXX-zone-residential:PASSWORD@brd.superproxy.io:22225"
```

## Setup for Claude Code

Add to your Claude Code MCP configuration (`~/.claude/claude_code_config.json` or per-project `.claude/config.json`):

```json
{
  "mcpServers": {
    "web-tools": {
      "command": "node",
      "args": ["/absolute/path/to/web-tools-mcp-server/dist/index.js"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key-here",
        "PROXY_URL": "http://user:pass@proxy:port",
        "JINA_API_KEY": "optional-jina-key"
      }
    }
  }
}
```

Or using the CLI:

```bash
claude mcp add web-tools \
  -e BRAVE_API_KEY=your-key \
  -e PROXY_URL=http://user:pass@proxy:port \
  -- node /absolute/path/to/web-tools-mcp-server/dist/index.js
```

## Setup for Claude AI (Desktop App)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "web-tools": {
      "command": "node",
      "args": ["/absolute/path/to/web-tools-mcp-server/dist/index.js"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key-here",
        "PROXY_URL": "http://user:pass@proxy:port",
        "JINA_API_KEY": "optional-jina-key"
      }
    }
  }
}
```

Restart the Claude desktop app after saving.

## Tools

### `web_search`

Search the web via Brave Search API.

**Parameters:**
- `query` (string, required): Search query. 1-6 words recommended.
- `count` (number, optional): Results count, 1-20. Default: 10.
- `offset` (number, optional): Pagination offset. Default: 0.
- `country` (string, optional): Two-letter country code (e.g., "us").
- `search_lang` (string, optional): Language code (e.g., "en").
- `freshness` (string, optional): Time filter — "pd", "pw", "pm", "py", or "YYYY-MM-DDtoYYYY-MM-DD".

### `web_fetch`

Fetch a URL with anti-detection capabilities.

**Parameters:**
- `url` (string, required): Full URL to fetch (must include https:// or http://).
- `strategy` (string, optional): Fetch strategy. Default: "auto".
  - `"auto"`: Direct fetch first, Jina Reader fallback on block.
  - `"direct"`: Direct fetch only (UA rotation + proxy).
  - `"jina"`: Jina Reader only (JS rendering, clean markdown output).

## Fetch Strategy Decision Guide

```
Is the site JS-heavy or known for aggressive anti-bot?
├── Yes ──► Use strategy="jina"
└── No
    ├── Do you have a proxy configured?
    │   ├── Yes ──► Use strategy="auto" (default) — direct with proxy, Jina fallback
    │   └── No  ──► Use strategy="auto" — tries without proxy, Jina catches failures
    └── Is it a raw API/JSON endpoint?
        └── Yes ──► Use strategy="direct" — Jina would mangle the JSON
```

## Updating User Agents

The user agent pool in `src/constants.ts` should be updated periodically to match current browser versions. Check [whatismybrowser.com/guides/the-latest-user-agent](https://www.whatismybrowser.com/guides/the-latest-user-agent/) for current strings.

## Cost Estimate

| Component | Cost | Notes |
|---|---|---|
| Brave Search API | $5/1k queries | $5 free credit/month |
| Jina Reader | Free tier | 1M tokens free, no key needed |
| Bright Data (optional) | ~$8-15/GB residential | Pay-as-you-go available |
| **Typical monthly for light use** | **~$0-5** | Under 1k searches + Jina free tier |

## Troubleshooting

**"BRAVE_API_KEY environment variable is required"**
→ Set the `BRAVE_API_KEY` env var in your MCP config.

**Direct fetch always returns 403**
→ Configure `PROXY_URL` with a residential proxy (Bright Data), or rely on Jina fallback (strategy="auto").

**Jina returns empty/garbage**
→ Some sites block Jina too. Configure a Bright Data residential proxy and use strategy="direct".

**"undici ProxyAgent could not be loaded"**
→ Your Node.js version doesn't bundle undici properly. Run: `npm install undici` in the project directory.

## License

MIT
