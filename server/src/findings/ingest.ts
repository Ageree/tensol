/**
 * T048 — findings ingest.
 *
 * Per Constitution VI (TDD red→green) and per `specs/002-blackbox-mvp/
 * data-model.md` §E5, this module turns one validated
 * `FindingFromAgent` (the post-schema-parse shape produced by
 * `WebhookScanCompleteBodySchema`) into:
 *
 *   1. exactly ONE row in the `findings` table with the full 18-column
 *      shape described in E5, and
 *   2. exactly ONE `finding_ingested` row appended to the signed audit
 *      chain via `emitSignedAudit` (per Constitution X — every state
 *      change emits a signed audit event).
 *
 * Why a factory (`createFindingsIngest`) rather than a free function:
 *   - The signing key lives in `config.TENSOL_AUDIT_SIGNING_KEY` and
 *     callers must thread it explicitly (Constitution VII bans hidden
 *     env reads inside business logic). The factory parks the key once
 *     at construction time so the route handler doesn't have to plumb
 *     it through every call site.
 *   - Tests can inject `newId` / `now` for deterministic byte-stable
 *     fixtures without monkey-patching the global `ulid()`.
 *
 * Idempotency note: this layer is INTENTIONALLY not idempotent — calling
 * `insertFinding` twice with the same input produces two rows + two
 * audit events. Dedup (if any) is the route handler's job, since the
 * dedup key (`(scan_id, external_id)`) is not yet a UNIQUE constraint
 * in the migration and that decision lives one layer up.
 *
 * Sibling: `server/src/schemas/webhook-scan-complete.ts` already parses
 * the wire-level YAML frontmatter into a typed `RawYamlFrontmatter` —
 * this module REUSES that typed result rather than re-parsing the YAML.
 */
import type { DB } from "../db/client.ts";
import { findings as findingsTable } from "../db/schema.ts";
import { emitSignedAudit } from "../audit/emit.ts";
import { ulid } from "../lib/ids.ts";
import { now as nowMs } from "../lib/time.ts";
import {
  RawYamlFrontmatterSchema,
  type FindingFromAgent,
  type RawYamlFrontmatter,
} from "../schemas/webhook-scan-complete.ts";

/** Per-call arguments. `now` is exposed so the route handler can pass
 *  a single wall-clock reading shared across many findings in one
 *  webhook delivery (keeps `created_at` monotonic within a batch). */
export interface InsertFindingArgs {
  readonly scanId: string;
  readonly target: string;
  readonly finding: FindingFromAgent;
  readonly now?: number;
}

/** Slim return type — full row reads can come back via a select later
 *  if a caller needs them. We return the freshly-minted `id` so the
 *  webhook handler can build its `Location: /v1/scans/:scanId/findings/:id`
 *  response without re-querying. */
export interface InsertedFinding {
  readonly id: string;
  readonly scanId: string;
  readonly externalId: string;
  readonly slug: string;
  readonly severity: string;
  readonly title: string;
}

/** Dependencies injected at factory construction time. */
export interface IngestDeps {
  readonly db: DB;
  readonly auditKey: string;
  readonly newId?: () => string;
  readonly clock?: () => number;
}

/** Factory return shape — single insert method today; future tasks may
 *  extend with `bulkInsert` once we measure how often >1 finding lands
 *  per webhook in practice. */
export interface FindingsIngest {
  insertFinding(args: InsertFindingArgs): Promise<InsertedFinding>;
}

/**
 * Derive a stable `slug` from the parsed frontmatter + body, mirroring
 * how Decepticon names finding files on disk.
 *
 * The agent already writes findings under
 * `/workspace/findings/{severity}-{slug}.md`; the slug there is
 * derived from the title + the FIND-NNN id. We don't yet receive the
 * filename on the wire (it was stripped by `FindingFromAgent`), so we
 * derive one locally: lowercase the title, keep alphanumerics + dashes,
 * collapse whitespace.
 *
 * This slug is **internal** — it's a convenience for filename round-trip
 * and is not stored in the DB as a column (data-model E5 has no `slug`
 * column; the `external_id` is the canonical handle). Exposed in the
 * return value so the route handler can use it for `Location` headers.
 */
function deriveSlug(fm: RawYamlFrontmatter): string {
  return fm.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Coerce a frontmatter `discovered_at` (ISO-8601 string OR unix ms) into
 * the unix-ms INTEGER the data-model E5 column expects.
 *
 * Returns `null` if absent or unparseable rather than throwing —
 * `discovered_at` is documented as optional, and an unparseable string
 * is treated as "not provided" by the data-model (the DB column is
 * nullable). Validation strictness lives at the schema layer; this
 * layer is the coercion bridge.
 */
function coerceDiscoveredAt(
  value: RawYamlFrontmatter["discovered_at"],
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Hand-rolled (regex) YAML-frontmatter splitter — kept exported per the
 * T048 brief. Returns the parsed-and-validated frontmatter object and
 * the body string (everything after the closing `---` fence). Throws
 * via the Zod schema if the frontmatter doesn't satisfy `id` /
 * `severity` / `title` invariants.
 *
 * The webhook ingest path itself does NOT go through this helper —
 * `WebhookScanCompleteBodySchema` already normalised the frontmatter
 * before `insertFinding` runs. This helper is exposed for non-webhook
 * callers (e.g. CLI replay of `.harness/` evidence files into a dev DB)
 * that still need to ingest a `.md` blob.
 */
export function parseYamlFrontmatter(md: string): {
  fm: RawYamlFrontmatter;
  body: string;
} {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      "parseYamlFrontmatter: missing or malformed `---` fences",
    );
  }
  const fmRaw = match[1]!;
  const body = match[2] ?? "";

  // Parse the YAML with Bun's native YAML.parse — passthrough schema in
  // RawYamlFrontmatterSchema will preserve unknown keys.
  const fmObj = Bun.YAML.parse(fmRaw) as Record<string, unknown>;
  const fm = RawYamlFrontmatterSchema.parse(fmObj);
  return { fm, body };
}

/**
 * Build a {@link FindingsIngest}.
 *
 * Constitution X: every successful insert emits one `finding_ingested`
 * audit row. The audit emit lives OUTSIDE the implicit transaction the
 * INSERT runs in — both run through their own `BEGIN IMMEDIATE` in
 * Drizzle. This is acceptable for v1 because:
 *   - the audit chain is append-only and the row only matters as a
 *     historical receipt; an audit row without a matching finding row
 *     would be a verifiable error, not a corruption.
 *   - wrapping both writes in one outer tx would require an audit-emit
 *     variant that runs inside a caller-supplied tx; that refactor is
 *     filed under T07x and isn't blocking US1.
 */
export function createFindingsIngest(deps: IngestDeps): FindingsIngest {
  const newId = deps.newId ?? ulid;
  const clock = deps.clock ?? nowMs;

  return {
    async insertFinding(args: InsertFindingArgs): Promise<InsertedFinding> {
      const fm = args.finding.raw_yaml_frontmatter;
      const ts = args.now ?? clock();
      const id = newId();
      const slug = deriveSlug(fm);
      const discoveredAtMs = coerceDiscoveredAt(fm.discovered_at);

      // Persist the entire normalised frontmatter object — Zod
      // `passthrough()` preserved unknown keys, so this is a complete
      // forward-compat snapshot per E5.raw_yaml_json.
      const rawYamlJson = JSON.stringify(fm);

      deps.db
        .insert(findingsTable)
        .values({
          id,
          scanId: args.scanId,
          externalId: fm.id,
          severity: fm.severity,
          title: fm.title,
          target: args.target,
          cvssScore: fm.cvss_score ?? null,
          cvssVector: fm.cvss_vector ?? null,
          cvssVersion: fm.cvss_version ?? null,
          cweJson: JSON.stringify(fm.cwe ?? []),
          mitreJson: JSON.stringify(fm.mitre ?? []),
          confidence: fm.confidence ?? null,
          phase: fm.phase ?? null,
          agent: fm.agent ?? null,
          bodyMd: args.finding.body_md,
          rawYamlJson,
          evidenceKeysJson: JSON.stringify(args.finding.evidence_keys),
          discoveredAt: discoveredAtMs,
          createdAt: ts,
        })
        .run();

      // Per Constitution X — emit signed audit. Severity replicated
      // onto the audit row so the analytics index `(severity, created_at)`
      // works without a join, matching how scan_started/scan_completed
      // already use top-level columns.
      await emitSignedAudit(
        deps.db,
        {
          event: "finding_ingested",
          outcome: "success",
          ts,
          scan_id: args.scanId,
          finding_id: id,
          severity: fm.severity,
          metadata: {
            external_id: fm.id,
            slug,
            cvss_score: fm.cvss_score ?? null,
            confidence: fm.confidence ?? null,
            phase: fm.phase ?? null,
            agent: fm.agent ?? null,
          },
        },
        { key: deps.auditKey },
      );

      return {
        id,
        scanId: args.scanId,
        externalId: fm.id,
        slug,
        severity: fm.severity,
        title: fm.title,
      };
    },
  };
}
