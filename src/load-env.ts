/**
 * Reads the server's own .env (next to package.json) into process.env.
 * Both entry points use it, so the API keys live in ONE file instead of being
 * copied into every client config that launches this server.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");

export function loadEnv(opts: { override: boolean; skip?: string[] }): void {
  let text: string;
  try {
    text = readFileSync(ENV_PATH, "utf8");
  } catch (err) {
    // No .env is fine: the keys can come from the client config's env block.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[web-tools-mcp] could not read ${ENV_PATH}:`, (err as Error).message);
    }
    return;
  }
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || opts.skip?.includes(m[1])) continue;
    if (!opts.override && process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
