// Sprint 6 — IPv4/IPv6 canonicalization + private/loopback/link-local/metadata
// classification.
//
// R4 — `canonical` does NOT include zone-id (`%eth0`, etc). The zone-id is
// returned in a side field; rule matchers compare against `canonical` only so
// `fe80::1%eth0` cannot smuggle past a deny rule on `fe80::1`.

import type { IpClassification, NormalizedIp } from '../types.ts';

export class IpNormalizationError extends Error {
  constructor(message: string) {
    super(`ip_normalization_error: ${message}`);
    this.name = 'IpNormalizationError';
  }
}

// ============================================================================
// IPv4
// ============================================================================
//
// Accepted shapes (Postel-style, with mandatory canonicalization on output):
//   - dotted decimal: 192.168.1.1
//   - leading-zero: 192.168.001.001
//   - octal: 0177.0.0.1   (any octet starting with `0` AND length > 1 AND digits in 0-7)
//   - hex: 0xc0.0xa8.0x01.0x01  (per-octet)
//   - integer: 3232235777    (single 32-bit unsigned)
//
// Output canonical = standard dotted decimal "a.b.c.d".

const parseIpv4Octet = (raw: string): number | null => {
  if (raw.length === 0) return null;
  // Hex form: 0x...
  if (raw === '0x' || raw === '0X') return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) {
    const v = Number.parseInt(raw.slice(2), 16);
    return Number.isFinite(v) ? v : null;
  }
  // Octal: leading 0, len > 1, digits 0-7.
  if (raw.length > 1 && raw.startsWith('0') && /^0[0-7]+$/.test(raw)) {
    const v = Number.parseInt(raw, 8);
    return Number.isFinite(v) ? v : null;
  }
  if (/^[0-9]+$/.test(raw)) {
    const v = Number.parseInt(raw, 10);
    return Number.isFinite(v) ? v : null;
  }
  return null;
};

const tryParseIpv4 = (input: string): [number, number, number, number] | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Single 32-bit unsigned integer form.
  if (/^[0-9]+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    }
    return null;
  }

  // Dotted form (any of dec/oct/hex per octet).
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const v = parseIpv4Octet(parts[i] ?? '');
    if (v === null || v < 0 || v > 255) return null;
    out[i] = v;
  }
  return out;
};

const ipv4Canonical = (octets: [number, number, number, number]): string => octets.join('.');

const classifyIpv4 = (octets: [number, number, number, number]): IpClassification => {
  const [a, b, ,] = octets;
  // Metadata IPs (cloud IMDS) — checked before private/link-local because
  // 169.254.169.254 ⊂ 169.254.0.0/16.
  if (a === 169 && b === 254 && octets[2] === 169 && octets[3] === 254) {
    return 'metadata';
  }
  if (a === 100 && b === 100 && octets[2] === 100 && octets[3] === 200) {
    return 'metadata'; // Yandex Cloud
  }
  if (a === 169 && b === 254) return 'link_local';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // CGNAT
  if (a === 0) return 'reserved';
  if (a >= 224 && a <= 239) return 'reserved'; // multicast
  if (a >= 240) return 'reserved';
  return 'public';
};

// ============================================================================
// IPv6
// ============================================================================

const expandIpv6Groups = (input: string): number[] | null => {
  // Strip zone-id; caller has already extracted it.
  let s = input;
  // Mapped IPv4: ::ffff:1.2.3.4 → expand the IPv4 trailing into two 16-bit groups.
  const v4MappedMatch = s.match(/^(.*:)([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/);
  if (v4MappedMatch) {
    const v4 = tryParseIpv4(v4MappedMatch[2] ?? '');
    if (!v4) return null;
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    s = `${v4MappedMatch[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }

  // Split on `::` (zero compression).
  const doubleColonCount = (s.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  // codex iter-7 P2 — strict per-group hex validation. `Number.parseInt('1zz', 16)`
  // returns 1 (stops at the first non-hex char), so `2001:db8::1zz` would have
  // been silently accepted as `2001:db8::1`. Reject the whole IPv6 if any group
  // contains a non-hex character or is longer than 4 hex digits.
  const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/i;
  const validHexGroups = (parts: readonly string[]): boolean =>
    parts.every((p) => HEX_GROUP_RE.test(p));

  let leftParts: string[];
  let rightParts: string[];
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    leftParts = (left ?? '') === '' ? [] : (left ?? '').split(':');
    rightParts = (right ?? '') === '' ? [] : (right ?? '').split(':');
    const total = leftParts.length + rightParts.length;
    if (total > 8) return null;
    if (!validHexGroups(leftParts) || !validHexGroups(rightParts)) return null;
    const zeros = new Array(8 - total).fill('0');
    return [...leftParts, ...zeros, ...rightParts].map((p) => Number.parseInt(p, 16));
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  if (!validHexGroups(parts)) return null;
  return parts.map((p) => Number.parseInt(p, 16));
};

const tryParseIpv6 = (input: string): { groups: number[]; zoneId?: string } | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Extract zone-id.
  const zoneIdx = trimmed.indexOf('%');
  let body: string;
  let zoneId: string | undefined;
  if (zoneIdx >= 0) {
    body = trimmed.slice(0, zoneIdx);
    zoneId = trimmed.slice(zoneIdx + 1);
    if (zoneId.length === 0) return null;
  } else {
    body = trimmed;
  }
  if (!body.includes(':')) return null;
  const groups = expandIpv6Groups(body);
  if (!groups) return null;
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!Number.isFinite(g) || g < 0 || g > 0xffff) return null;
  }
  const result: { groups: number[]; zoneId?: string } = { groups };
  if (zoneId !== undefined) result.zoneId = zoneId;
  return result;
};

/** RFC 5952 — compress longest run of zeros (≥2 groups) once; lowercase hex. */
const ipv6Canonical = (groups: number[]): string => {
  // Find longest run of zero groups (≥2).
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) {
    return groups.map((g) => g.toString(16)).join(':');
  }
  const left = groups
    .slice(0, bestStart)
    .map((g) => g.toString(16))
    .join(':');
  const right = groups
    .slice(bestStart + bestLen)
    .map((g) => g.toString(16))
    .join(':');
  return `${left}::${right}`;
};

const classifyIpv6 = (groups: number[]): IpClassification => {
  // ::1 loopback
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return 'loopback';
  }
  // fe80::/10 link-local
  if ((groups[0] ?? 0) >= 0xfe80 && (groups[0] ?? 0) <= 0xfebf) return 'link_local';
  // fc00::/7 unique-local (private)
  if (((groups[0] ?? 0) & 0xfe00) === 0xfc00) return 'private';
  // ::ffff:0:0/96 mapped IPv4 — classify via the embedded v4.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = ((groups[6] ?? 0) >>> 8) & 0xff;
    const b = (groups[6] ?? 0) & 0xff;
    const c = ((groups[7] ?? 0) >>> 8) & 0xff;
    const d = (groups[7] ?? 0) & 0xff;
    return classifyIpv4([a, b, c, d]);
  }
  // ff00::/8 multicast = reserved here.
  if (((groups[0] ?? 0) & 0xff00) === 0xff00) return 'reserved';
  return 'public';
};

// ============================================================================
// Public entry
// ============================================================================

export const normalizeIp = (input: string): NormalizedIp => {
  if (typeof input !== 'string') throw new IpNormalizationError('ip must be a string');
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new IpNormalizationError('ip is empty');

  const v4 = tryParseIpv4(trimmed);
  if (v4) {
    return {
      family: 'ipv4',
      canonical: ipv4Canonical(v4),
      classification: classifyIpv4(v4),
    };
  }
  const v6 = tryParseIpv6(trimmed);
  if (v6) {
    const result: NormalizedIp = {
      family: 'ipv6',
      canonical: ipv6Canonical(v6.groups),
      classification: classifyIpv6(v6.groups),
      ...(v6.zoneId !== undefined ? { zoneId: v6.zoneId } : {}),
    };
    return result;
  }
  throw new IpNormalizationError(`invalid ip: ${trimmed}`);
};
