/**
 * SSRF guard. Public pages go through BrightData; in local stdio mode
 * localhost / private URLs get a plain fetch (see fetcher.ts).
 *
 * The HTTP connector is reachable from the internet (secret link), and a page
 * the model reads could talk it into fetching http://127.0.0.1:<port>/ — every
 * app on the host may listen on loopback. With BLOCK_PRIVATE_ADDRESSES=true, the
 * direct fetcher refuses loopback / private / link-local / CGNAT / multicast
 * targets and this machine's own interface addresses.
 *
 * The check runs on the address the socket actually connects to (custom DNS
 * lookup on the undici Agent), so DNS rebinding can't slip past it, plus a
 * pre-check for IP-literal hosts (which skip DNS) on every redirect hop.
 * Off by default so a local MCP client can still fetch localhost dev servers.
 */
import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import { Agent } from "undici";

export const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_ADDRESSES === "true";

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockList.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockList.addSubnet(addr, prefix, "ipv6");
}
// This server's own addresses (public IP included): reaching ourselves directly
// would bypass the vhost's Cloudflare-only ACL.
for (const ifaces of Object.values(os.networkInterfaces())) {
  for (const i of ifaces ?? []) {
    blockList.addAddress(i.address.split("%")[0], i.family === "IPv6" ? "ipv6" : "ipv4");
  }
}

export function isBlockedAddress(ip: string): boolean {
  let addr = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const family = net.isIP(addr);
  if (family === 4) return blockList.check(addr, "ipv4");
  if (family === 6) return blockList.check(addr, "ipv6");
  return false;
}

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** Throw if the URL is not http(s) or names a blocked IP literal / localhost. */
export function assertPublicUrl(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new BlockedAddressError(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedAddressError(`Only http(s) URLs can be fetched (got ${u.protocol})`);
  }
  if (!BLOCK_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new BlockedAddressError(`Refusing to fetch a local address: ${u.hostname}`);
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new BlockedAddressError(`Refusing to fetch a private/internal address: ${u.hostname}`);
  }
}

/**
 * True for URLs that only make sense from this machine: localhost, *.local,
 * dotless hostnames and private / loopback / own-interface IP literals.
 */
export function isLocalUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) return isBlockedAddress(host);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) {
      return callback(
        new BlockedAddressError(`Refusing to fetch ${hostname}: it resolves to internal address ${bad.address}`),
        ""
      );
    }
    if (!list.length) return callback(new Error(`No addresses for ${hostname}`), "");
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** undici dispatcher for direct fetches: guarded when BLOCK_PRIVATE is on. */
export const directAgent = new Agent(
  BLOCK_PRIVATE ? { connect: { lookup: guardedLookup as never } } : {}
);
