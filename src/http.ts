#!/usr/bin/env node
/**
 * Streamable-HTTP entry point: a remote MCP connector.
 *
 *   https://example.com/search-mcp/<MCP_SECRET>
 *
 * The secret in the path IS the credential — anyone with the link can use it,
 * nobody without it can tell the endpoint exists (everything else is a 404).
 * Stateless: every POST gets a fresh server + transport, JSON responses (no
 * SSE stream to buffer through Cloudflare/OpenLiteSpeed).
 */
import "./http-env.js";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const SECRET = process.env.MCP_SECRET ?? "";
if (SECRET.length < 24) {
  console.error("[web-tools-mcp] MCP_SECRET is missing or shorter than 24 characters — refusing to start");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 6014);
// Not HOSTNAME: many shells export HOSTNAME (the machine name) and pm2 --update-env would inject it.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const BASE_PATH = (process.env.BASE_PATH || "/search-mcp").replace(/\/+$/, "");

const secretDigest = createHash("sha256").update(SECRET).digest();
const secretOk = (candidate: string) =>
  timingSafeEqual(createHash("sha256").update(candidate).digest(), secretDigest);

function describeCall(body: unknown): string {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs
    .map((m: any) => {
      if (m?.method !== "tools/call") return m?.method ?? "?";
      const a = m.params?.arguments ?? {};
      const detail = a.query ?? a.url ?? (Array.isArray(a.urls) ? `${a.urls.length} urls` : "");
      return `tools/call ${m.params?.name} ${JSON.stringify(detail).slice(0, 120)}`;
    })
    .join(", ");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

app.all([`${BASE_PATH}/:secret`, `${BASE_PATH}/:secret/mcp`], async (req: Request, res: Response) => {
  if (!secretOk(String(req.params.secret))) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    return;
  }

  const started = Date.now();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    console.log(`[mcp] ${describeCall(req.body)} → ${res.statusCode} in ${Date.now() - started}ms`);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).type("text/plain").send("Not found");
});

// Malformed JSON bodies and the like
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`[web-tools-mcp] HTTP connector on http://${BIND_HOST}:${PORT}${BASE_PATH}/<secret>`);
  console.log(
    `[web-tools-mcp] Brave key: ${process.env.BRAVE_API_KEY ? "ok" : "MISSING"} | BrightData: ${process.env.BRIGHTDATA_API_KEY ? `ok (zone ${process.env.BRIGHTDATA_ZONE || "web_unlocker2"})` : "MISSING — web_fetch will fail"} | private-address block: ${process.env.BLOCK_PRIVATE_ADDRESSES}`
  );
});
