/**
 * Env for the HTTP connector. Imported FIRST by http.ts so values are in place
 * before other modules read process.env at import time. Overrides inherited
 * variables on purpose: a login shell may export stale keys or HOSTNAME.
 */
import { loadEnv } from "./load-env.js";

loadEnv({ override: true });

// The public connector must never be able to reach the host's internal ports.
process.env.BLOCK_PRIVATE_ADDRESSES ??= "true";
