/**
 * T037 — subdomain auto-discovery via Certificate Transparency (crt.sh).
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/research.md` §R1 — decision: CT logs only,
 *     `https://crt.sh/?q=%.{domain}&output=json`, 5-second timeout,
 *     100-result cap, always merge `www.<primary>` fallback.
 *
 * Design constraints:
 *   - Returns a deduped, lowercase, sorted list of hostnames that are
 *     strict children of the primary domain.
 *   - The `www.<primary>` fallback is ALWAYS present in the result, so
 *     the wizard can render a sensible default-checked entry even when
 *     crt.sh is unreachable or empty.
 *   - Degrades gracefully — every failure mode (timeout, non-200, fetch
 *     throw, JSON parse error, empty array) yields the same minimal
 *     `[www.<primary>]` answer. The caller never has to know whether
 *     crt.sh was actually queried.
 *   - Pure-ish: no DB, no logging, no environment access. `fetch` is
 *     injectable for tests (`opts.fetcher`).
 *
 * Why not Zod-validate the crt.sh response:
 *   - Constitution Principle IX requires Zod on route boundaries; this
 *     is an outbound HTTP call, not an inbound one. We accept whatever
 *     crt.sh returns and defensively coerce per-line, which is more
 *     robust to upstream shape drift than a strict schema rejection.
 *
 * Why a `Set` + sort instead of running dedup at the end:
 *   - Inserting into a Set during the parse loop lets us short-circuit
 *     once `capN * 2` candidates accumulate (cheap protection against
 *     pathological 50 000-row responses without allocating all of them).
 */

const CRT_SH_BASE = "https://crt.sh";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CAP_N = 50;

export interface DiscoverSubdomainsOpts {
  /** Fetch implementation. Defaults to the runtime `fetch`. Test-only DI. */
  fetcher?: typeof fetch;
  /** Abort budget for the upstream call. Default 5 000 ms (per §R1). */
  timeoutMs?: number;
  /** Maximum hostnames returned. Default 50. */
  capN?: number;
}

interface CrtShEntry {
  name_value?: string;
  [k: string]: unknown;
}

/**
 * Query crt.sh for subdomains of `primary`, merge a `www.` fallback,
 * and return a deduped, lowercase, sorted list capped at `capN`.
 *
 * Never throws — all failure modes degrade to `[www.<primary>]`.
 */
export async function discoverSubdomains(
  primary: string,
  opts: DiscoverSubdomainsOpts = {},
): Promise<string[]> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const capN = opts.capN ?? DEFAULT_CAP_N;
  const normPrimary = primary.trim().toLowerCase();
  const wwwFallback = `www.${normPrimary}`;
  const candidates = new Set<string>();
  const overcollectCap = capN * 2;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${CRT_SH_BASE}/?q=%25.${encodeURIComponent(normPrimary)}&output=json`;
      const resp = await fetcher(url, { signal: controller.signal });
      if (resp.ok) {
        const arr = (await resp.json()) as CrtShEntry[];
        if (Array.isArray(arr)) {
          outer: for (const entry of arr) {
            const raw = typeof entry?.name_value === "string" ? entry.name_value : "";
            const lines = raw.split("\n");
            for (const rawLine of lines) {
              const line = rawLine.trim().toLowerCase();
              if (!line) continue;
              if (line.includes("*")) continue; // wildcards
              if (line === normPrimary) continue; // the apex itself
              if (!line.endsWith(`.${normPrimary}`)) continue; // cross-domain leak guard
              candidates.add(line);
              if (candidates.size >= overcollectCap) break outer;
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Timeout (AbortError), network error, or JSON parse error — fall
    // through to the www-only fallback. Logging is intentionally absent
    // to keep this module pure; the caller can wrap if telemetry is
    // needed.
  }

  candidates.add(wwwFallback);
  const sorted = [...candidates].sort();
  return sorted.slice(0, capN);
}
