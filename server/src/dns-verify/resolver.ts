/**
 * T032 — DNS TXT resolver with multi-server agreement.
 *
 * Constitution II (NON-NEGOTIABLE): scope-of-authorization. The user proves
 * they control a domain by publishing a TXT record; we query independent
 * public resolvers and require agreement to defeat split-DNS and rogue
 * resolvers.
 *
 * Per research §R6: query 4 public DNS servers across two independent
 * vendors (Cloudflare 1.1.1.1 / 1.0.0.1, Google 8.8.8.8 / 8.8.4.4) and
 * return the intersection of the TXT records all of them returned. Any
 * timeout / NXDOMAIN / SERVFAIL in any resolver collapses the result to
 * null — caller treats this as "not yet verified, retry next poll".
 *
 * Spec FR-009: use public, independent DNS resolvers (not the system
 * resolver) to mitigate spoofing.
 */

import { promises as dnsPromises } from "node:dns";

/**
 * Canonical 4-server list. Cloudflare + Google = two-vendor agreement.
 * Order is load-bearing for the "wiring" test in resolver.test.ts.
 */
export const RESOLVERS_DEFAULT = [
  "1.1.1.1", // Cloudflare primary
  "1.0.0.1", // Cloudflare secondary
  "8.8.8.8", // Google primary
  "8.8.4.4", // Google secondary
] as const;

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Minimal interface for the slice of dns.promises.Resolver we use, kept
 * narrow so tests can substitute a fake without depending on Node internals.
 */
export interface TxtResolver {
  setServers(servers: string[]): void;
  resolveTxt(name: string): Promise<string[][]>;
}

export interface ResolveTxtOpts {
  /** Override the default 4-server list (mostly for tests). */
  servers?: readonly string[];
  /** Factory for injecting a fake Resolver in tests. */
  makeResolver?: () => TxtResolver;
  /** Per-resolver timeout in ms (default 5000). */
  timeoutMs?: number;
}

/**
 * Race a promise against a timeout, returning the first to settle.
 * Used per-resolver so one slow vendor cannot block the others.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("DNS_TIMEOUT"), { code: "ETIMEOUT" }));
        }, ms);
        // unref so a stuck timer never blocks process exit
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Query the TXT record set for `domain` against each configured resolver
 * and return the intersection of records all resolvers agreed on.
 *
 * Returns `null` when:
 *   - any resolver fails (timeout / NXDOMAIN / SERVFAIL / any error)
 *   - the intersection across all 4 record sets is empty
 *
 * Returns `string[]` (joined TXT records) when all resolvers returned at
 * least one record in common.
 */
export async function resolveTxtAgreed(
  domain: string,
  opts: ResolveTxtOpts = {},
): Promise<string[] | null> {
  const servers = opts.servers ?? RESOLVERS_DEFAULT;
  const makeResolver =
    opts.makeResolver ?? ((): TxtResolver => new dnsPromises.Resolver());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const queries = servers.map(async (server): Promise<string[]> => {
    const resolver = makeResolver();
    resolver.setServers([server]);
    const chunks = await withTimeout(resolver.resolveTxt(domain), timeoutMs);
    // dns.promises.resolveTxt returns string[][]: outer = records,
    // inner = byte chunks (TXT segments capped at 255 bytes). Join inner.
    return chunks.map((rec) => rec.join(""));
  });

  const settled = await Promise.allSettled(queries);

  // Constitution II: any failure collapses to "not verified, retry later".
  // No partial-agreement quorum — agreement is unanimous across all queried
  // resolvers per research §R6 ("null if any timeout").
  const recordSets: string[][] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") return null;
    recordSets.push(result.value);
  }

  if (recordSets.length === 0) return null;

  // Intersection: keep records present in EVERY resolver's response.
  const first = recordSets[0];
  if (first === undefined) return null;
  const rest = recordSets.slice(1);
  const intersection = first.filter((rec) =>
    rest.every((set) => set.includes(rec)),
  );
  // Dedupe while preserving first-seen order (Set keeps insertion order).
  const deduped = Array.from(new Set(intersection));

  return deduped.length > 0 ? deduped : null;
}
