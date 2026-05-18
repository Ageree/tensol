/**
 * T033 — verifyChallenge: probe a target's ownership challenge via DNS TXT,
 *        well-known file, or HTML meta-tag, then atomically mark the target
 *        + auth_proof verified on the first successful probe.
 *
 * Design contract:
 *   - All three probes are pluggable via `deps` so the unit tests never
 *     touch the network. `resolveTxt` mirrors `node:dns/promises.resolveTxt`
 *     (returns `string[][]`). `fetchUrl` is a minimal `{ ok, status, text() }`
 *     shape — strictly the surface we need from `globalThis.fetch`.
 *   - Probes are attempted in a fixed order (dns_txt → well_known_file →
 *     meta_tag) unless `preferMethod` is provided, in which case the
 *     preferred method runs FIRST and the others fall back behind it.
 *   - Any thrown error inside a probe is captured (succeeded=false,
 *     note=err.message) — a probe failure never crashes the verify call.
 *   - On the first success we open a transaction to:
 *       1. UPDATE targets SET status='verified', verified_at=now() WHERE id=…
 *       2. UPDATE auth_proofs SET status='verified', method=<col>,
 *          verified_at=now() WHERE id=…
 *     The audit row is emitted AFTER the tx commits (T021/T028 pattern:
 *     `emitSignedAudit` opens its own BEGIN IMMEDIATE; bun:sqlite cannot
 *     nest BEGINs).
 *
 * Schema-vs-API mapping (subtle):
 *   - `auth_proofs.method` enum is `"dns_txt" | "file" | "meta_tag"`.
 *   - The public ProbeMethod string for the file probe is `"well_known_file"`
 *     (matches the OpenAPI contract and the ChallengeInstructions key from
 *     T032). We translate via `methodToColumn` before persisting.
 *   - `targets` has NO `verified_method` column — we record the method in
 *     the `auth_proof_verified` audit metadata, NOT on the target row.
 *
 * HTTPS probes use AbortSignal.timeout(HTTPS_TIMEOUT_MS) to bound the wait.
 * The signal is forwarded to `deps.fetchUrl` so tests can ignore it but
 * production callers (T035 routes layer) wire it straight into `fetch`.
 */
import { eq } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import { authProofs, targets } from "../db/schema.ts";
import { now as defaultNow } from "../lib/time.ts";

/** Public probe method identifiers. Note `well_known_file` differs from the
 *  underlying SQLite `auth_proofs.method` enum value `file` — see mapping
 *  in `methodToColumn`. */
export type ProbeMethod = "dns_txt" | "well_known_file" | "meta_tag";

export interface AttemptedProbe {
  readonly method: ProbeMethod;
  readonly succeeded: boolean;
  readonly note: string;
}

/** Minimal Response surface used by verify — keeps the mock simple. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text: () => Promise<string>;
}

export interface VerifyDeps {
  /** Mirrors node:dns/promises.resolveTxt — returns chunked TXT records. */
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** Production callers pass `globalThis.fetch`. Tests pass a fake. */
  fetchUrl: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<FetchResponseLike>;
}

export interface VerifyOptions {
  readonly signingKey: string;
  readonly preferMethod?: ProbeMethod;
  readonly now?: () => number;
}

export type VerifyResult =
  | {
      readonly ok: true;
      readonly verified: true;
      readonly method: ProbeMethod;
      readonly attempted: readonly AttemptedProbe[];
    }
  | {
      readonly ok: false;
      readonly code: 410;
      readonly reason: "expired" | "no_challenge";
      readonly attempted: readonly AttemptedProbe[];
    }
  | {
      readonly ok: false;
      readonly code: 422;
      readonly reason: "all_failed";
      readonly attempted: readonly AttemptedProbe[];
    };

/** Default order when `preferMethod` is omitted. */
const DEFAULT_ORDER: readonly ProbeMethod[] = [
  "dns_txt",
  "well_known_file",
  "meta_tag",
];

/** DNS subdomain prefix that issueChallenge documented in T032. */
const DNS_TXT_PREFIX = "_tensol-verify.";

/** Well-known HTTP path the verifier fetches for the file method. */
const WELL_KNOWN_PATH = "/.well-known/tensol-verify.txt";

/** Meta-tag matcher. Allows single or double quotes around name/content
 *  per HTML spec and is case-insensitive on the attribute names. */
const META_TAG_RE =
  /<meta\s+[^>]*name=["']tensol-verify["'][^>]*content=["']([^"']+)["'][^>]*>/i;

/** Also accept attribute order content-before-name, which is valid HTML. */
const META_TAG_RE_ALT =
  /<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']tensol-verify["'][^>]*>/i;

/** Hard cap on HTTPS probe wait. 10s is generous enough for slow TLS
 *  handshakes but short enough that three probes finish within the 60s
 *  request budget on the verify endpoint. */
const HTTPS_TIMEOUT_MS = 10_000;

/** DNS TXT value prefix from issueChallenge: `tensol-verify=<hex>`. */
const TOKEN_VALUE_PREFIX = "tensol-verify=";

/** Map public ProbeMethod → DB enum column value. The schema picked the
 *  short name `file` for the file probe; the public API surface uses the
 *  more explicit `well_known_file`. */
function methodToColumn(m: ProbeMethod): "dns_txt" | "file" | "meta_tag" {
  if (m === "well_known_file") return "file";
  return m;
}

/** Build the probe-order list for a single verify call. */
function buildOrder(prefer?: ProbeMethod): ProbeMethod[] {
  if (!prefer) return [...DEFAULT_ORDER];
  return [prefer, ...DEFAULT_ORDER.filter((m) => m !== prefer)];
}

/** Extract the hostname from a target URL. We trust the URL was normalised
 *  upstream by the targets service (T029) so parsing should never throw,
 *  but we still catch to surface a clear error. */
function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (e) {
    throw new Error(
      `verifyChallenge: malformed target URL ${url}: ${(e as Error).message}`,
    );
  }
}

/** Extract the raw hex token from the stored `tensol-verify=<hex>` value. */
function rawHexFromChallenge(challenge: string): string {
  if (challenge.startsWith(TOKEN_VALUE_PREFIX)) {
    return challenge.slice(TOKEN_VALUE_PREFIX.length);
  }
  // Defensive: if the prefix is somehow missing, treat the whole value as raw.
  return challenge;
}

// ---------------------------------------------------------------------------
// Probe runners — each returns an AttemptedProbe (never throws).
// ---------------------------------------------------------------------------

async function probeDnsTxt(
  deps: VerifyDeps,
  hostname: string,
  expectedDnsValue: string,
): Promise<AttemptedProbe> {
  const recordName = `${DNS_TXT_PREFIX}${hostname}`;
  try {
    const records = await deps.resolveTxt(recordName);
    // Each record is an array of strings (RFC 1035 long TXT chunks).
    // Join chunks within a record before comparison; do NOT join across
    // records — separate records are independent claims.
    const joined = records.map((chunks) => chunks.join(""));
    const hit = joined.find((v) => v === expectedDnsValue);
    if (hit) {
      return {
        method: "dns_txt",
        succeeded: true,
        note: `matched TXT record at ${recordName}`,
      };
    }
    return {
      method: "dns_txt",
      succeeded: false,
      note:
        joined.length === 0
          ? `no TXT records at ${recordName}`
          : `TXT records present at ${recordName} but none matched expected value`,
    };
  } catch (e) {
    return {
      method: "dns_txt",
      succeeded: false,
      note: (e as Error).message ?? "dns probe threw",
    };
  }
}

async function probeWellKnownFile(
  deps: VerifyDeps,
  hostname: string,
  expectedToken: string,
): Promise<AttemptedProbe> {
  const url = `https://${hostname}${WELL_KNOWN_PATH}`;
  try {
    const signal = AbortSignal.timeout(HTTPS_TIMEOUT_MS);
    const res = await deps.fetchUrl(url, { signal });
    if (!res.ok) {
      return {
        method: "well_known_file",
        succeeded: false,
        note: `HTTP ${res.status} at ${url}`,
      };
    }
    const body = (await res.text()).trim();
    if (body === expectedToken) {
      return {
        method: "well_known_file",
        succeeded: true,
        note: `matched file body at ${url}`,
      };
    }
    return {
      method: "well_known_file",
      succeeded: false,
      note: `file body at ${url} did not match expected token`,
    };
  } catch (e) {
    return {
      method: "well_known_file",
      succeeded: false,
      note: (e as Error).message ?? "file probe threw",
    };
  }
}

async function probeMetaTag(
  deps: VerifyDeps,
  hostname: string,
  expectedToken: string,
): Promise<AttemptedProbe> {
  const url = `https://${hostname}/`;
  try {
    const signal = AbortSignal.timeout(HTTPS_TIMEOUT_MS);
    const res = await deps.fetchUrl(url, { signal });
    if (!res.ok) {
      return {
        method: "meta_tag",
        succeeded: false,
        note: `HTTP ${res.status} at ${url}`,
      };
    }
    const body = await res.text();
    const m1 = META_TAG_RE.exec(body);
    const m2 = m1 ? null : META_TAG_RE_ALT.exec(body);
    const captured = m1?.[1] ?? m2?.[1];
    if (captured === expectedToken) {
      return {
        method: "meta_tag",
        succeeded: true,
        note: `matched meta tag at ${url}`,
      };
    }
    if (captured !== undefined) {
      return {
        method: "meta_tag",
        succeeded: false,
        note: `meta tag at ${url} held a value but it did not match`,
      };
    }
    return {
      method: "meta_tag",
      succeeded: false,
      note: `no tensol-verify meta tag found at ${url}`,
    };
  } catch (e) {
    return {
      method: "meta_tag",
      succeeded: false,
      note: (e as Error).message ?? "meta probe threw",
    };
  }
}

async function runProbe(
  method: ProbeMethod,
  deps: VerifyDeps,
  hostname: string,
  rawHex: string,
): Promise<AttemptedProbe> {
  switch (method) {
    case "dns_txt":
      return probeDnsTxt(deps, hostname, `${TOKEN_VALUE_PREFIX}${rawHex}`);
    case "well_known_file":
      return probeWellKnownFile(deps, hostname, rawHex);
    case "meta_tag":
      return probeMetaTag(deps, hostname, rawHex);
  }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export interface VerifyChallengeArgs {
  readonly targetId: string;
}

export async function verifyChallenge(
  db: DB,
  args: VerifyChallengeArgs,
  deps: VerifyDeps,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  if (!opts.signingKey) {
    throw new Error(
      "verifyChallenge: signingKey is required (audit row cannot be signed)",
    );
  }
  const clock = opts.now ?? defaultNow;

  // 1. Pick the most recent challenge for this target.
  const proofRow = db
    .select()
    .from(authProofs)
    .where(eq(authProofs.targetId, args.targetId))
    .orderBy(authProofs.createdAt)
    .all()
    .at(-1);

  if (!proofRow) {
    return { ok: false, code: 410, reason: "no_challenge", attempted: [] };
  }

  // 2. Expiry check — fast path before any network probes.
  const tsNow = clock();
  if (tsNow >= proofRow.expiresAt) {
    // Audit AFTER computing result. Best-effort: a failure to emit must
    // not change the user-facing return (the row is still expired).
    try {
      await emitSignedAudit(
        db,
        {
          event: "auth_proof_failed",
          outcome: "failure",
          ts: tsNow,
          target_id: args.targetId,
          auth_proof_id: proofRow.id,
          metadata: { reason: "expired" },
        },
        { key: opts.signingKey },
      );
    } catch {
      // Swallow — see comment above.
    }
    return { ok: false, code: 410, reason: "expired", attempted: [] };
  }

  // 3. Look up the target to derive the hostname for probe URLs.
  const targetRow = db
    .select()
    .from(targets)
    .where(eq(targets.id, args.targetId))
    .get();
  if (!targetRow) {
    // FK guarantees this should not happen given the proof row exists, but
    // surface a clear failure rather than crashing further down.
    return { ok: false, code: 410, reason: "no_challenge", attempted: [] };
  }
  const hostname = hostnameFromUrl(targetRow.url);
  const rawHex = rawHexFromChallenge(proofRow.challenge);

  // 4. Run probes in order; stop at the first success.
  const order = buildOrder(opts.preferMethod);
  const attempted: AttemptedProbe[] = [];
  let winning: ProbeMethod | null = null;
  for (const method of order) {
    const outcome = await runProbe(method, deps, hostname, rawHex);
    attempted.push(outcome);
    if (outcome.succeeded) {
      winning = method;
      break;
    }
  }

  // 5a. All failed → 422 + audit.
  if (!winning) {
    try {
      await emitSignedAudit(
        db,
        {
          event: "auth_proof_failed",
          outcome: "failure",
          ts: tsNow,
          target_id: args.targetId,
          auth_proof_id: proofRow.id,
          metadata: { reason: "all_failed" },
        },
        { key: opts.signingKey },
      );
    } catch {
      // Swallow.
    }
    return { ok: false, code: 422, reason: "all_failed", attempted };
  }

  // 5b. Success: persist verified state, then emit audit AFTER tx commits.
  const dbMethod = methodToColumn(winning);
  await withTx(db, async (tx) => {
    tx.update(targets)
      .set({ status: "verified", verifiedAt: tsNow })
      .where(eq(targets.id, args.targetId))
      .run();
    tx.update(authProofs)
      .set({ status: "verified", method: dbMethod, verifiedAt: tsNow })
      .where(eq(authProofs.id, proofRow.id))
      .run();
  });

  await emitSignedAudit(
    db,
    {
      event: "auth_proof_verified",
      outcome: "success",
      ts: tsNow,
      target_id: args.targetId,
      auth_proof_id: proofRow.id,
      metadata: { method: winning },
    },
    { key: opts.signingKey },
  );

  return { ok: true, verified: true, method: winning, attempted };
}
