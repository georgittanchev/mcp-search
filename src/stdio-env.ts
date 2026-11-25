/**
 * Env for the stdio server that the MCP client spawns. Imported FIRST by index.ts.
 * Takes the API keys and limits from .env but not the connector-only settings:
 * locally, fetching localhost dev servers must keep working, so the private-
 * address block stays off. Values set by the launching config win.
 */
import { loadEnv } from "./load-env.js";

loadEnv({
  override: false,
  skip: ["MCP_SECRET", "PORT", "BIND_HOST", "BASE_PATH", "BLOCK_PRIVATE_ADDRESSES"],
});
