/**
 * 003-whitebox — `/v1/review/*` authenticated REST API.
 *
 * Public surface (mounted at `/v1/review` from server.ts):
 *
 *   POST   /                  → run a review on a supplied diff/files (SYNC).
 *                               Used by the `tensol-loop` CLI skill: the client
 *                               already has the diff, so no GitHub creds are
 *                               needed and the engine runs inline.
 *   GET    /:id               → review row + its findings (owner-scoped).
 *   GET    /                  → list the caller's reviews.
 *   GET    /repos             → list the caller's connected repos.
 *   POST   /whitebox          → enqueue a whole-repo whitebox scan (ASYNC, 202).
 *
 * Ownership (Constitution II): every read confirms `review.userId === caller`.
 * A foreign / unknown id → 404 (never 403; hides existence).
 *
 * Validation (Constitution IX): bodies are validated with the Zod schemas in
 * `review/schemas.ts` before any work.
 *
 * Audit (Constitution X): the service emits every signed audit row; the route
 * never writes the audit log directly.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { AuthVariables } from "../auth/middleware.ts";
import type { DB } from "../db/client.ts";
import { createRateLimit, defaultKeyFn } from "../lib/rate-limit.ts";
import { runReview } from "../review/engine.ts";
import { fileToAddedDiff } from "../review/repo-fetch.ts";
import { splitUnifiedDiff } from "../review/candidates.ts";
import type { LlmClient } from "../review/reviewer.ts";
import {
  MAX_TOTAL_REVIEW_BYTES,
  ReviewApiBodySchema,
  WhiteboxLaunchBodySchema,
  type ReviewApiBody,
} from "../review/schemas.ts";
import type { ReviewService } from "../review/service.ts";
import type { DiffFile, ReviewFinding, ReviewResult } from "../review/types.ts";

export interface CreateReviewRouterDeps {
  readonly db: DB;
  readonly service: ReviewService;
  readonly requireAuth: MiddlewareHandler<{ Variables: AuthVariables }>;
  /** Server-configured review LLM; null when no API key is set (→ 503). */
  readonly llm: LlmClient | null;
  readonly now?: () => number;
}

interface ErrorEnvelope {
  readonly error: string;
  readonly message: string;
}

const NOT_FOUND: ErrorEnvelope = { error: "not_found", message: "resource not found" };
const LLM_UNCONFIGURED: ErrorEnvelope = {
  error: "review_llm_unconfigured",
  message: "the review LLM is not configured on this server (set TENSOL_REVIEW_LLM_API_KEY)",
};

/** Split an "owner/name" slug. */
function splitRepo(slug: string): { owner: string; name: string } {
  const idx = slug.indexOf("/");
  return { owner: slug.slice(0, idx), name: slug.slice(idx + 1) };
}

/** Map an API body's files/diff into engine `DiffFile`s. */
function bodyToFiles(body: ReviewApiBody): DiffFile[] {
  if (body.files && body.files.length > 0) {
    return body.files.map((f): DiffFile => {
      // Prefer an explicit patch; else synthesize a full-add patch from
      // `contents` so the engine produces whole-file candidates.
      const patch =
        f.patch !== undefined
          ? f.patch
          : f.contents !== undefined
            ? fileToAddedDiff(f.contents)
            : undefined;
      return {
        path: f.path,
        status: f.status,
        ...(patch !== undefined ? { patch } : {}),
        ...(f.previous_path !== undefined ? { previousPath: f.previous_path } : {}),
      };
    });
  }
  if (body.diff) return splitUnifiedDiff(body.diff);
  return [];
}

/**
 * Canonical domain `ReviewFinding` → wire (snake_case) mapper — the SINGLE
 * source of truth for the finding shape, so the sync POST / and GET /:id paths
 * cannot drift (e.g. one path dropping `side`). Row-only fields (`id`,
 * `lifecycle_state`) are appended by `findingRowToWire`.
 */
function findingToWire(f: ReviewFinding) {
  return {
    fingerprint: f.fingerprint,
    file_path: f.filePath,
    start_line: f.startLine ?? null,
    end_line: f.endLine ?? null,
    side: f.side,
    severity: f.severity,
    cwe: f.cwe,
    cvss_vector: f.cvssVector,
    cvss_score: f.cvssScore,
    confidence: f.confidence,
    reachable: f.reachable,
    category: f.category,
    title: f.title,
    rationale_md: f.rationaleMd,
    poc_md: f.pocMd ?? null,
    fix_prompt_md: f.fixPromptMd ?? null,
    source: f.source,
  };
}

/** Serialize a ReviewFinding DB row for the API (snake_case wire shape). */
function findingRowToWire(row: {
  id: string;
  fingerprint: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  side: string;
  severity: string;
  cweJson: string;
  cvssVector: string | null;
  cvssScore: number | null;
  confidence: string | null;
  reachable: number | null;
  category: string | null;
  title: string;
  rationaleMd: string;
  pocMd: string | null;
  fixPromptMd: string | null;
  source: string;
  lifecycleState: string;
}) {
  let cwe: string[] = [];
  try {
    const parsed = JSON.parse(row.cweJson);
    if (Array.isArray(parsed)) cwe = parsed as string[];
  } catch {
    cwe = [];
  }
  // Normalize the DB row into the domain shape (parse cweJson, 0/1→bool), run
  // it through the canonical mapper, then append the row-only fields.
  const domain: ReviewFinding = {
    fingerprint: row.fingerprint,
    filePath: row.filePath,
    ...(row.startLine !== null ? { startLine: row.startLine } : {}),
    ...(row.endLine !== null ? { endLine: row.endLine } : {}),
    side: row.side as ReviewFinding["side"],
    severity: row.severity as ReviewFinding["severity"],
    cwe,
    cvssVector: row.cvssVector ?? "",
    cvssScore: row.cvssScore ?? 0,
    confidence: (row.confidence ?? "low") as ReviewFinding["confidence"],
    reachable: row.reachable === 1,
    category: row.category ?? "",
    title: row.title,
    rationaleMd: row.rationaleMd,
    ...(row.pocMd !== null ? { pocMd: row.pocMd } : {}),
    ...(row.fixPromptMd !== null ? { fixPromptMd: row.fixPromptMd } : {}),
    source: row.source as ReviewFinding["source"],
  };
  return {
    ...findingToWire(domain),
    // Preserve the DB's exact persisted values for the nullable scoring/columns
    // (the row is authoritative; don't coerce a stored null into a default).
    cvss_vector: row.cvssVector,
    cvss_score: row.cvssScore,
    confidence: row.confidence,
    reachable: row.reachable === null ? null : row.reachable === 1,
    category: row.category,
    id: row.id,
    lifecycle_state: row.lifecycleState,
  };
}

/** ReviewResult → wire shape (for the sync POST / response). */
function resultToWire(reviewId: string, result: ReviewResult) {
  return {
    review_id: reviewId,
    kind: result.kind,
    // The sync path always finalizes the review to `completed` before
    // responding; `status` is REQUIRED by ReviewResultWire + api.md.
    status: "completed" as const,
    score_0_5: result.score0to5,
    summary_md: result.summaryMd,
    findings: result.findings.map(findingToWire),
  };
}

export function createReviewRouter(
  deps: CreateReviewRouterDeps,
): Hono<{ Variables: AuthVariables }> {
  const { service, requireAuth, llm } = deps;

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth);
  // Per-user rate limit AFTER auth (keyed by user id, IP fallback). The review
  // endpoints are expensive (LLM call + repo clone + SAST), so cap abuse — and
  // bound the cost of any pathological input that slips past the body caps.
  app.use(
    "*",
    createRateLimit({
      windowMs: 60_000,
      max: 30,
      keyFn: (c) => {
        const u = c.get("user") as { id?: string } | undefined;
        return u?.id ?? defaultKeyFn(c);
      },
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    }),
  );

  // -------------------------------------------------------------------------
  // POST / — synchronous review of a supplied diff/files.
  //
  // `bodyLimit` rejects an oversized body with 413 on Content-Length / streamed
  // size BEFORE `c.req.json()` buffers + parses it (per-field Zod caps run only
  // after the whole body is materialized, too late to prevent the allocation).
  // Headroom over MAX_TOTAL_REVIEW_BYTES covers the JSON envelope + path/sha
  // fields + base64/escape expansion.
  // -------------------------------------------------------------------------
  const reviewBodyLimit = bodyLimit({
    maxSize: MAX_TOTAL_REVIEW_BYTES + 256 * 1024,
    onError: (c) =>
      c.json(
        { error: "payload_too_large", message: "request body exceeds the size limit" },
        413,
      ),
  });

  app.post("/", reviewBodyLimit, async (c) => {
    if (!llm) return c.json(LLM_UNCONFIGURED, 503);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
    }
    const parsed = ReviewApiBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_failed",
          message: parsed.error.issues[0]?.message ?? "invalid body",
          issues: parsed.error.issues,
        },
        422,
      );
    }
    const body = parsed.data;
    const user = c.get("user");
    const { owner, name } = splitRepo(body.repo);

    const repo = await service.upsertRepo({ userId: user.id, owner, name });
    const review = await service.createReview({
      repoId: repo.id,
      userId: user.id,
      kind: "pr",
      ...(body.pr !== undefined ? { prNumber: body.pr } : {}),
      ...(body.head_sha !== undefined ? { headSha: body.head_sha } : {}),
      ...(body.base_sha !== undefined ? { baseSha: body.base_sha } : {}),
    });

    try {
      await service.markReviewRunning(review.id);
      const files = bodyToFiles(body);
      const result = await runReview(
        {
          kind: "pr",
          files,
          ...(repo.rulesMd ? { rulesMd: repo.rulesMd } : {}),
        },
        { llm },
      );
      await service.finalizeReview(review.id, result);
      return c.json(resultToWire(review.id, result), 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Persist the detailed cause server-side (audit + reviews.error), but
      // return a generic message — raw upstream/LLM error text can leak provider
      // identifiers or internal detail to the client.
      await service.failReview(review.id, msg);
      return c.json(
        { error: "review_failed", message: "review engine failed", review_id: review.id },
        500,
      );
    }
  });

  // -------------------------------------------------------------------------
  // GET /repos — list the caller's connected repos.
  // (Registered before /:id so "repos" is not captured as an id.)
  // -------------------------------------------------------------------------
  app.get("/repos", async (c) => {
    const user = c.get("user");
    const repos = await service.listReposByUser(user.id);
    return c.json(
      repos.map((r) => ({
        id: r.id,
        scm: r.scm,
        owner: r.owner,
        name: r.name,
        full_name: `${r.owner}/${r.name}`,
        default_branch: r.defaultBranch,
        status: r.status,
        created_at: r.createdAt,
      })),
      200,
    );
  });

  // -------------------------------------------------------------------------
  // GET / — list the caller's reviews.
  //
  // Emits a distinct list shape (`ReviewListItemWire`): `review_id` (NOT `id`)
  // and a real `findings_count` (counted, not the full `findings` array) so the
  // client's Reviews table can read `r.review_id` + `r.findings_count` without
  // a crash. NEVER includes a `findings` array (that's the detail endpoint).
  // -------------------------------------------------------------------------
  app.get("/", async (c) => {
    const user = c.get("user");
    const reviews = await service.listReviewsByUser(user.id);
    const counts = await service.countFindingsByReviewIds(
      reviews.map((r) => r.id),
    );
    const repos = await service.listReposByUser(user.id);
    const repoSlug = new Map(repos.map((r) => [r.id, `${r.owner}/${r.name}`]));
    return c.json(
      reviews.map((r) => ({
        review_id: r.id,
        kind: r.kind,
        status: r.status,
        score_0_5: r.score0to5,
        pr_number: r.prNumber,
        repo: r.repoId ? repoSlug.get(r.repoId) ?? null : null,
        created_at: r.createdAt,
        completed_at: r.completedAt,
        findings_count: counts[r.id] ?? 0,
      })),
      200,
    );
  });

  // -------------------------------------------------------------------------
  // GET /:id — review + findings (owner-scoped).
  // -------------------------------------------------------------------------
  app.get("/:id", async (c) => {
    const user = c.get("user");
    const review = await service.getReview(c.req.param("id"));
    if (!review || review.userId !== user.id) return c.json(NOT_FOUND, 404);
    const findings = await service.getReviewFindings(review.id);
    return c.json(
      {
        id: review.id,
        repo_id: review.repoId,
        kind: review.kind,
        pr_number: review.prNumber,
        head_sha: review.headSha,
        status: review.status,
        score_0_5: review.score0to5,
        summary_md: review.summaryMd,
        findings_count: review.findingsCount,
        error: review.error,
        created_at: review.createdAt,
        completed_at: review.completedAt,
        findings: findings.map(findingRowToWire),
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // POST /whitebox — enqueue a whole-repo whitebox scan (async).
  // -------------------------------------------------------------------------
  app.post("/whitebox", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "body must be JSON" }, 400);
    }
    const parsed = WhiteboxLaunchBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "validation_failed",
          message: parsed.error.issues[0]?.message ?? "invalid body",
          issues: parsed.error.issues,
        },
        422,
      );
    }
    const body = parsed.data;
    const user = c.get("user");

    // Resolve the repo: an existing connected repo id, or create from a slug.
    let repoId: string;
    if (body.repo_id) {
      const repo = await service.getRepo(body.repo_id);
      if (!repo || repo.userId !== user.id) return c.json(NOT_FOUND, 404);
      repoId = repo.id;
    } else if (body.repo) {
      const { owner, name } = splitRepo(body.repo);
      const repo = await service.upsertRepo({ userId: user.id, owner, name });
      repoId = repo.id;
    } else {
      return c.json(
        { error: "validation_failed", message: "repo_id or repo is required" },
        422,
      );
    }

    // Atomic: the queued review + its pending whitebox_scan job commit together.
    const { review, jobId } = await service.createQueuedReviewWithJob(
      {
        repoId,
        userId: user.id,
        kind: "whitebox",
        ...(body.ref !== undefined ? { commitRef: body.ref } : {}),
      },
      "whitebox_scan",
    );

    return c.json({ review_id: review.id, job_id: jobId, status: "queued" }, 202);
  });

  return app;
}
