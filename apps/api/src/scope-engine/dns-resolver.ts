// Sprint 6 — DNS resolver adapter.
//
// Lives OUTSIDE the engine package precisely to keep `packages/scope-engine`
// I/O-free (A-SE-Pure-1). The engine consumes the `DnsResolver` interface;
// this file is the only one in the platform that imports `node:dns/promises`
// for production resolution.

import { lookup, resolve4, resolve6 } from 'node:dns/promises';
import type { DnsResolver } from '@cyberstrike/scope-engine';

const onErr = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [] as T[]);

/**
 * 2026-05-12 — fallback path. Some host configurations (notably macOS with
 * managed/VPN profiles) leave the `dns.resolve*` raw-resolver path broken
 * (ECONNREFUSED on the configured DNS server) while `dns.lookup`/getaddrinfo
 * still resolves via mDNS or OS-level. We try `resolve4`/`resolve6` first
 * (faster, can return ALL records) and fall back to `lookup` when the raw
 * resolver path returns empty — this keeps prod behaviour identical on
 * properly-configured Linux servers while letting dev work on broken macOS.
 */
const lookupAll = async (host: string, family: 4 | 6): Promise<string[]> => {
  try {
    const rows = await lookup(host, { all: true, family });
    return rows.map((r) => r.address);
  } catch {
    return [];
  }
};

export const nodeDnsResolver: DnsResolver = {
  resolveA: async (host) => {
    const direct = await onErr(resolve4(host));
    return direct.length > 0 ? direct : lookupAll(host, 4);
  },
  resolveAAAA: async (host) => {
    const direct = await onErr(resolve6(host));
    return direct.length > 0 ? direct : lookupAll(host, 6);
  },
};

/**
 * Test/seam DNS resolver — fed a static table.
 */
export const inMemoryDnsResolver = (
  table: Record<string, { a?: readonly string[]; aaaa?: readonly string[] }>,
): DnsResolver => ({
  resolveA: async (host) => [...(table[host]?.a ?? [])],
  resolveAAAA: async (host) => [...(table[host]?.aaaa ?? [])],
});
