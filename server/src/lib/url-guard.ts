/**
 * URL guard — SSRF prevention for target perimeters and self-checks.
 *
 * Rejects:
 *  - malformed strings
 *  - non-http(s) schemes (file://, javascript:, ftp://, data:, …)
 *  - private / loopback / link-local IPv4 and IPv6
 *  - 169.254.169.254 (AWS instance metadata) and the rest of the link-local /16
 *  - hostnames named `localhost` or ending in `.localhost`
 *
 * No DNS resolution is performed. Hostnames that *resolve* to private IPs but
 * are not literal IP addresses pass this check; defense-in-depth at request
 * time (with a resolving guard) is layered on top in the scan runner.
 */

export type GuardResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function reject(reason: string): GuardResult {
  return { ok: false, reason };
}

function parseIPv4(host: string): number[] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const octets = [m[1]!, m[2]!, m[3]!, m[4]!].map((s) => Number.parseInt(s, 10));
  for (const o of octets) {
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes AWS metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — b in [16, 31]
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  // Normalize to lower-case, strip zone id if present.
  const lower = addr.toLowerCase().split("%")[0]!;
  if (lower === "::" || lower === "::1") return true;
  // fc00::/7 — Unique Local Address (fc.. or fd..)
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  // fe80::/10 — link-local (fe80.. through febf..)
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ::ffff:<v4> — IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) {
    const octets = parseIPv4(mapped[1]!);
    if (octets && isPrivateIPv4(octets)) return true;
  }
  return false;
}

function isLocalhostName(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  if (lower.endsWith(".localhost")) return true;
  if (lower === "localhost.localdomain") return true;
  return false;
}

export function guardTargetUrl(input: string): GuardResult {
  if (typeof input !== "string") return reject("not a string");
  const trimmed = input.trim();
  if (trimmed.length === 0) return reject("empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("malformed url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject(`unsupported scheme: ${url.protocol}`);
  }

  // url.hostname keeps IPv6 square brackets — strip them for inspection.
  let host = url.hostname;
  if (host.length === 0) return reject("empty hostname");
  const isBracketedV6 = host.startsWith("[") && host.endsWith("]");
  if (isBracketedV6) {
    host = host.slice(1, -1);
  }

  if (isLocalhostName(host)) {
    return reject("localhost hostnames are not allowed");
  }

  // IPv4 literal?
  const v4 = parseIPv4(host);
  if (v4) {
    if (isPrivateIPv4(v4)) {
      return reject(`private IPv4 not allowed: ${host}`);
    }
    return { ok: true, url };
  }

  // IPv6 literal — only when host came in brackets, or contains ':'.
  if (isBracketedV6 || host.includes(":")) {
    if (isPrivateIPv6(host)) {
      return reject(`private IPv6 not allowed: ${host}`);
    }
    return { ok: true, url };
  }

  return { ok: true, url };
}
