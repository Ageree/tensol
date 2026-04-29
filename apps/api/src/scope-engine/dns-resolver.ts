// Sprint 6 — DNS resolver adapter.
//
// Lives OUTSIDE the engine package precisely to keep `packages/scope-engine`
// I/O-free (A-SE-Pure-1). The engine consumes the `DnsResolver` interface;
// this file is the only one in the platform that imports `node:dns/promises`
// for production resolution.

import { resolve4, resolve6 } from 'node:dns/promises';
import type { DnsResolver } from '@cyberstrike/scope-engine';

const onErr = async <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [] as T[]);

/**
 * Production DNS resolver — consults the system resolver via `node:dns`.
 * Errors are swallowed and return `[]` so a `NXDOMAIN` doesn't escape into the
 * engine's normalization layer; the engine's deny-by-default posture handles
 * the empty IP list correctly.
 */
export const nodeDnsResolver: DnsResolver = {
  resolveA: async (host) => onErr(resolve4(host)),
  resolveAAAA: async (host) => onErr(resolve6(host)),
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
