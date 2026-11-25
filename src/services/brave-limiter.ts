/**
 * Brave Search free-plan guard: 1 request/second and a monthly cap (2,000).
 *
 * Several processes share ONE Brave key: every local client session spawns its
 * own stdio copy of this server, and the HTTP connector runs under pm2. An
 * in-memory limiter would let them collide, so the state lives in a small JSON
 * file guarded by an O_EXCL lock file. Each caller reserves the next free
 * 1.1-second slot under the lock (held for milliseconds, never across the
 * HTTP call), then sleeps until its slot.
 *
 * The monthly count is re-synced from Brave's own X-RateLimit-* headers on
 * every response, so requests made by any other client of the same key are
 * reflected too.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR =
  process.env.WEB_TOOLS_DATA_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const STATE_FILE = path.join(DATA_DIR, "brave-state.json");
const LOCK_FILE = path.join(DATA_DIR, "brave-state.lock");

export const BRAVE_MONTHLY_LIMIT = Number(process.env.BRAVE_MONTHLY_LIMIT || 2000);
export const BRAVE_MIN_INTERVAL_MS = Number(process.env.BRAVE_MIN_INTERVAL_MS || 1100);
/** Refuse instead of queueing when the line is longer than this. */
const MAX_QUEUE_WAIT_MS = 45_000;
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;

interface BraveState {
  /** epoch ms of the latest reserved request slot (any process) */
  lastSlotAt: number;
  /** calendar month "YYYY-MM" — the fallback window until Brave reports its own */
  periodKey: string;
  /** requests sent in the current window, counted locally (all processes) */
  used: number;
  /** values reported by Brave's X-RateLimit-* headers (authoritative when present) */
  braveLimit?: number;
  braveRemaining?: number;
  braveResetAt?: number;
  updatedAt: number;
}

export interface BraveQuota {
  limit: number;
  remaining: number;
  resetAt?: number;
  source: "brave-headers" | "local-count";
}

export class BraveQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BraveQuotaError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

function freshState(now: number): BraveState {
  return { lastSlotAt: 0, periodKey: monthKey(now), used: 0, updatedAt: now };
}

async function readState(now: number): Promise<BraveState> {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return { ...freshState(now), ...raw };
  } catch {
    return freshState(now);
  }
}

async function writeState(s: BraveState): Promise<void> {
  // write-then-rename: atomic, and works no matter which OS user (root for
  // stdio, a service user for pm2) created the previous file — only directory
  // write permission is needed.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o664 });
  await fs.rename(tmp, STATE_FILE);
}

/** Start a new window when Brave's reset time (or, lacking it, the calendar month) has passed. */
function rollWindow(s: BraveState, now: number): BraveState {
  if (s.braveResetAt !== undefined) {
    if (now >= s.braveResetAt) {
      return { ...freshState(now), lastSlotAt: s.lastSlotAt };
    }
    return s;
  }
  if (s.periodKey !== monthKey(now)) {
    return { ...freshState(now), lastSlotAt: s.lastSlotAt };
  }
  return s;
}

function quotaOf(s: BraveState): BraveQuota {
  if (s.braveRemaining !== undefined) {
    return {
      limit: s.braveLimit ?? BRAVE_MONTHLY_LIMIT,
      remaining: Math.max(0, s.braveRemaining),
      resetAt: s.braveResetAt,
      source: "brave-headers",
    };
  }
  return {
    limit: BRAVE_MONTHLY_LIMIT,
    remaining: Math.max(0, BRAVE_MONTHLY_LIMIT - s.used),
    source: "local-count",
  };
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const h = await fs.open(LOCK_FILE, "wx");
      await h.close();
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await fs.stat(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // holder crashed mid-update
          await fs.unlink(LOCK_FILE).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the Brave rate-limit lock");
      }
      await sleep(10 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(LOCK_FILE).catch(() => {});
  }
}

function fmtDate(ms?: number): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "the start of next month";
}

/**
 * Reserve the next 1-req/s slot and one unit of monthly quota, then wait for
 * the slot. Throws BraveQuotaError when the month is used up.
 */
export async function reserveBraveSlot(): Promise<void> {
  const slotAt = await withLock(async () => {
    const now = Date.now();
    const s = rollWindow(await readState(now), now);
    const q = quotaOf(s);
    if (q.remaining <= 0) {
      await writeState(s);
      throw new BraveQuotaError(
        `Brave Search monthly quota is used up (${q.limit}/month). It resets ${fmtDate(q.resetAt)}.`
      );
    }
    const slot = Math.max(now, s.lastSlotAt + BRAVE_MIN_INTERVAL_MS);
    if (slot - now > MAX_QUEUE_WAIT_MS) {
      throw new Error(
        `Brave Search queue is ${Math.round((slot - now) / 1000)}s long (1 request/second limit). Try again shortly.`
      );
    }
    s.lastSlotAt = slot;
    s.used += 1;
    if (s.braveRemaining !== undefined) s.braveRemaining -= 1;
    s.updatedAt = now;
    await writeState(s);
    return slot;
  });
  const wait = slotAt - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Last comma-separated value of an X-RateLimit-* header = the monthly window. */
function monthlyValue(h: string | null): number | undefined {
  if (!h) return undefined;
  const parts = h.split(",").map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
  return parts.length ? parts[parts.length - 1] : undefined;
}

/** Sync the shared state with what Brave says about the monthly window. */
export async function recordBraveHeaders(headers: Headers): Promise<void> {
  const limit = monthlyValue(headers.get("x-ratelimit-limit"));
  const remaining = monthlyValue(headers.get("x-ratelimit-remaining"));
  const resetSec = monthlyValue(headers.get("x-ratelimit-reset"));
  if (remaining === undefined) return;
  await withLock(async () => {
    const now = Date.now();
    const s = rollWindow(await readState(now), now);
    const resetAt = resetSec !== undefined ? now + resetSec * 1000 : s.braveResetAt;
    const newWindow =
      s.braveResetAt === undefined ||
      (resetAt !== undefined && Math.abs(resetAt - s.braveResetAt) > 6 * 3600_000);
    // Within one window, never move remaining UP: another process may have
    // spent quota after this response was generated.
    s.braveRemaining =
      newWindow || s.braveRemaining === undefined
        ? remaining
        : Math.min(s.braveRemaining, remaining);
    if (limit !== undefined) s.braveLimit = limit;
    if (resetAt !== undefined) s.braveResetAt = resetAt;
    s.updatedAt = now;
    await writeState(s);
  });
}

export async function getBraveQuota(): Promise<BraveQuota> {
  const now = Date.now();
  return quotaOf(rollWindow(await readState(now), now));
}
