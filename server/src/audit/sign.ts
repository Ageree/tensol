/**
 * Audit canonical-message + HMAC signer.
 *
 * Ported 1:1 from EE-2 `packages/audit/src/signer.ts` and `writer.ts`
 * (commit `84963f2`, see memory `project_tensol_runtime_readiness_2026-05-12.md`
 * and `specs/001-backend-v2/research.md` Decision 4).
 *
 * The 13-field, pipe-delimited canonical message + alpha-sorted metadata JSON
 * is a load-bearing invariant per Constitution II: any out-of-band verifier
 * built against v1 audit chains MUST keep working on rows signed by this
 * file. Do NOT change field order, separators, or sort semantics without a
 * coordinated chain-versioning migration.
 *
 * Differences vs EE-2:
 *   - Output is hex (not base64url) — backend v2 `audit_log.signature` and
 *     `prev_signature` columns are TEXT containing hex per data-model.md.
 *     `lib/crypto.hmacSha256` already returns hex, so we use that.
 *   - Schema fields renamed (no tenants/actors here) — see `AuditEntry`.
 *   - `prev_signature` is the 13th field of the canonical message itself,
 *     not concatenated outside it. This is the v2 convention.
 */

import { hmacSha256 } from "../lib/crypto.ts";

/**
 * Audit-log entry, mirrors `schema.ts` `auditLog` columns except `id`
 * (assigned by SQLite) and `signature` (output of `signEntry`).
 *
 * `ts` is epoch ms (matches schema). It is rendered as ISO 8601 UTC when
 * placed into the canonical message.
 *
 * `metadataJson` is the structured object — it is JSON-serialised with
 * alpha-sorted top-level keys inside `canonicalMessage`. Callers MUST pass
 * the object (not a pre-stringified JSON) so canonicalisation is centralised.
 */
export interface AuditEntry {
  readonly event: string;
  readonly ts: number;
  readonly userId: string | null;
  readonly projectId: string | null;
  readonly targetId: string | null;
  readonly scanId: string | null;
  readonly vpsInstanceId: string | null;
  readonly authProofId: string | null;
  readonly findingId: string | null;
  readonly severity: string | null;
  readonly outcome: "success" | "failure" | "rejected";
  readonly metadataJson: Record<string, unknown>;
}

/**
 * Alpha-sort top-level keys for stable JSON encoding. Top-level only —
 * matching EE-2 behaviour. Callers wanting recursive stability must
 * canonicalise nested objects before passing them in.
 *
 * Empty metadata serialises to `"{}"` (NOT to an empty string) so the
 * 13-field shape stays consistent.
 */
function canonicaliseMetadata(m: Record<string, unknown>): string {
  if (!m || Object.keys(m).length === 0) return "{}";
  const sortedKeys = Object.keys(m).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = m[k];
  return JSON.stringify(sorted);
}

/**
 * Build the 13-field pipe-delimited canonical message.
 *
 * Field order (FROZEN — see research.md Decision 4):
 *   1. event
 *   2. ts (ISO 8601 UTC, from epoch ms)
 *   3. user_id  (empty if null)
 *   4. project_id
 *   5. target_id
 *   6. scan_id
 *   7. vps_instance_id
 *   8. auth_proof_id
 *   9. finding_id
 *  10. severity
 *  11. outcome
 *  12. metadata_json (alpha-sorted keys; `{}` if empty)
 *  13. prev_signature (empty for the first row)
 *
 * `prevSig` can be null or empty string — both are treated as the
 * empty 13th field (first row in chain).
 */
export function canonicalMessage(entry: AuditEntry, prevSig: string | null): string {
  const fields: readonly string[] = [
    entry.event,
    new Date(entry.ts).toISOString(),
    entry.userId ?? "",
    entry.projectId ?? "",
    entry.targetId ?? "",
    entry.scanId ?? "",
    entry.vpsInstanceId ?? "",
    entry.authProofId ?? "",
    entry.findingId ?? "",
    entry.severity ?? "",
    entry.outcome,
    canonicaliseMetadata(entry.metadataJson),
    prevSig ?? "",
  ];
  return fields.join("|");
}

/**
 * HMAC-SHA256 (hex) over the canonical message.
 *
 * `key` is the signing secret. Caller is responsible for sourcing it
 * (e.g. base64-decoding `TENSOL_AUDIT_SIGNING_KEY`).
 *
 * `prevSig` is the hex signature of the previous audit row, or `null`
 * for the first row of the chain (which canonicalises to an empty 13th
 * field).
 */
export function signEntry(
  key: string | Uint8Array,
  entry: AuditEntry,
  prevSig: string | null,
): string {
  return hmacSha256(key, canonicalMessage(entry, prevSig));
}
