/**
 * 003-whitebox — review persistence service.
 *
 * Owns all DB writes for the review domain (repos / reviews / findings /
 * threads / feedback) and emits the signed audit rows (Constitution X:
 * audit emission lives in the service, not the route). Mirrors the patterns
 * in `findings/service.ts` + `scan-orders/service.ts`.
 *
 * The signed-audit writer (`emitSignedAudit`) owns its own BEGIN IMMEDIATE
 * transaction, so it is always called OUTSIDE `withTx` blocks (bun:sqlite
 * forbids nested BEGINs — same rule as the webhook handlers).
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  installations as installationsTable,
  jobs as jobsTable,
  reviewFeedback as reviewFeedbackTable,
  reviewFindings as reviewFindingsTable,
  reviewRepos as reviewReposTable,
  reviews as reviewsTable,
  reviewThreads as reviewThreadsTable,
  webhookDedup as webhookDedupTable,
  type Installation,
  type Review,
  type ReviewFeedback,
  type ReviewFinding as ReviewFindingRow,
  type ReviewRepo,
  type ReviewThread,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import type { ReviewKind, ReviewResult } from "./types.ts";

export interface CreateReviewServiceDeps {
  readonly db: DB;
  /** Audit-chain HMAC signing key. */
  readonly auditKey: string;
  /** Clock injection (tests use a frozen/monotonic clock). */
  readonly now?: () => number;
}

export interface UpsertRepoArgs {
  readonly userId: string;
  readonly scm?: "github" | "gitlab" | "bitbucket";
  readonly owner: string;
  readonly name: string;
  readonly installationId?: string | null;
  readonly defaultBranch?: string;
  readonly coveredBranches?: string[];
  readonly rulesMd?: string | null;
}

export interface CreateReviewArgs {
  readonly repoId?: string | null;
  readonly userId?: string | null;
  readonly kind: ReviewKind;
  readonly prNumber?: number | null;
  readonly headSha?: string | null;
  readonly baseSha?: string | null;
  readonly commitRef?: string | null;
}

export interface UpsertThreadArgs {
  readonly reviewId: string;
  readonly repoId: string;
  readonly fingerprint: string;
  readonly githubThreadId?: string | null;
  readonly githubCommentId?: string | null;
}

export interface RecordFeedbackArgs {
  readonly repoId: string;
  readonly fingerprint?: string | null;
  readonly signal: "up" | "down" | "addressed" | "ignored";
  readonly commentText?: string | null;
  readonly embeddingJson?: string | null;
}

export interface UpsertInstallationArgs {
  readonly userId: string;
  readonly scm?: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly repositorySelection: "all" | "selected";
  readonly status?: "active" | "suspended" | "deleted";
  readonly setupAction?: string | null;
}

export interface ReviewService {
  upsertRepo(args: UpsertRepoArgs): Promise<ReviewRepo>;
  getRepoByFullName(
    scm: string,
    owner: string,
    name: string,
  ): Promise<ReviewRepo | null>;
  /**
   * Resolve a connected repo by its SIGNED GitHub `installation_id` (the only
   * trustworthy tenant identifier on a webhook), asserting the event's
   * owner/name match the stored row. Returns null when no row matches the
   * installation, or when the installation's stored slug differs from the
   * event's — so an attacker who minted a row for `victim/secret` under their
   * OWN user can never be resolved from a victim's webhook (which carries the
   * victim's installation id, not the attacker's). The per-user
   * `(scm,owner,name,user_id)` unique index means `(owner,name)` alone can match
   * multiple tenants — `installation_id` disambiguates to exactly one.
   */
  getRepoByInstallation(
    scm: string,
    installationId: string,
    owner: string,
    name: string,
  ): Promise<ReviewRepo | null>;
  getRepo(id: string): Promise<ReviewRepo | null>;
  listReposByUser(userId: string): Promise<ReviewRepo[]>;
  createReview(args: CreateReviewArgs): Promise<Review>;
  /**
   * Atomically insert a queued review + its `pending` job in ONE transaction,
   * so a crash can never leave a `queued` review with no job to run it.
   *
   * When `dedup` is supplied (webhook delivery), its `webhook_dedup` row is
   * inserted FIRST inside the SAME transaction. A UNIQUE collision rolls the
   * whole tx back (no orphan review/job) and resolves with `{duplicate:true}`.
   * Committing the dedup row in the same tx as the work means a crash before
   * commit also rolls the dedup row back, so GitHub's retry re-processes the
   * delivery instead of being swallowed as a duplicate with no review.
   */
  createQueuedReviewWithJob(
    args: CreateReviewArgs,
    jobType: "pr_review" | "whitebox_scan",
    dedup?: {
      id: string;
      webhookKind: string;
      dedupKey: string;
      receivedAt: number;
      metadataJson: string;
    },
  ): Promise<{ review: Review; jobId: string; duplicate: boolean }>;
  markReviewRunning(id: string): Promise<Review>;
  finalizeReview(id: string, result: ReviewResult): Promise<Review>;
  failReview(id: string, error: string): Promise<Review>;
  getReview(id: string): Promise<Review | null>;
  listReviewsByRepo(repoId: string): Promise<Review[]>;
  listReviewsByUser(userId: string): Promise<Review[]>;
  getReviewFindings(reviewId: string): Promise<ReviewFindingRow[]>;
  /**
   * Count persisted `review_findings` rows per review id, WITHOUT loading the
   * full findings. Returns a map keyed by review id; ids with no findings are
   * absent (treat as 0). Used by the list endpoint's `findings_count`.
   */
  countFindingsByReviewIds(
    reviewIds: string[],
  ): Promise<Record<string, number>>;
  upsertThread(args: UpsertThreadArgs): Promise<ReviewThread>;
  getOpenThread(
    repoId: string,
    fingerprint: string,
  ): Promise<ReviewThread | null>;
  markThreadResolved(id: string): Promise<void>;
  recordFeedback(args: RecordFeedbackArgs): Promise<ReviewFeedback>;
  listFeedback(
    repoId: string,
    signal?: "up" | "down" | "addressed" | "ignored",
  ): Promise<ReviewFeedback[]>;

  // -------------------------------------------------------------------------
  // Installations CRUD (T005/T006 — feature 004: Sthrip PR Review)
  // -------------------------------------------------------------------------
  /**
   * Create or update a GitHub App installation row.
   * Idempotent by (scm, installationId) — the UNIQUE index prevents two rows
   * for the same external installation. On insert, emits `github_app_installed`.
   * Ownership (userId) is set at creation and NEVER reassigned on upsert.
   */
  upsertInstallation(args: UpsertInstallationArgs): Promise<Installation>;
  /**
   * Resolve an installation by its SCM-signed external id.
   * Returns null when absent — callers treat unknown ids as 404.
   */
  getInstallationByGithubId(
    scm: string,
    installationId: string,
  ): Promise<Installation | null>;
  /** Return all active/suspended installations owned by a user. */
  getInstallationsForUser(userId: string): Promise<Installation[]>;
  /**
   * Mark an installation as deleted and cascade-disable all its linked
   * `review_repos` rows (set enabled=0). Emits `github_app_uninstalled`.
   */
  markInstallationDeleted(installationId: string): Promise<void>;
  /**
   * Transition installation status (active ↔ suspended).
   * Emits `github_app_suspended` when transitioning TO suspended.
   * Does NOT re-emit when transitioning back to active (no audit event
   * for unsuspend — the install audit chain already records the round-trip).
   */
  setInstallationStatus(
    installationId: string,
    status: "active" | "suspended",
  ): Promise<Installation>;
}

/** True when a SQLite error is a UNIQUE-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return (
    typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")
  );
}

export function createReviewService(deps: CreateReviewServiceDeps): ReviewService {
  const { db, auditKey } = deps;
  const clock = deps.now ?? defaultNow;

  async function emit(
    event: string,
    outcome: "success" | "failure" | "rejected",
    metadata: Record<string, unknown>,
    userId?: string | null,
  ): Promise<void> {
    await emitSignedAudit(
      db,
      { event, outcome, ts: clock(), user_id: userId ?? null, metadata },
      { key: auditKey },
    );
  }

  return {
    async upsertRepo(args) {
      const scm = args.scm ?? "github";
      // USER-SCOPED lookup (multi-tenant isolation): a caller can only ever
      // find/update their OWN row for (scm,owner,name) — never another tenant's.
      // The unique index is (scm,owner,name,user_id) so each user gets a row.
      const existing = db
        .select()
        .from(reviewReposTable)
        .where(
          and(
            eq(reviewReposTable.scm, scm),
            eq(reviewReposTable.owner, args.owner),
            eq(reviewReposTable.name, args.name),
            eq(reviewReposTable.userId, args.userId),
          ),
        )
        .get();
      const ts = clock();
      if (existing) {
        db.update(reviewReposTable)
          .set({
            installationId:
              args.installationId === undefined
                ? existing.installationId
                : args.installationId,
            defaultBranch: args.defaultBranch ?? existing.defaultBranch,
            coveredBranchesJson: args.coveredBranches
              ? JSON.stringify(args.coveredBranches)
              : existing.coveredBranchesJson,
            rulesMd:
              args.rulesMd === undefined ? existing.rulesMd : args.rulesMd,
            updatedAt: ts,
          })
          .where(eq(reviewReposTable.id, existing.id))
          .run();
        const updated = db
          .select()
          .from(reviewReposTable)
          .where(eq(reviewReposTable.id, existing.id))
          .get();
        return updated as ReviewRepo;
      }
      const id = ulid(ts);
      const row = {
        id,
        userId: args.userId,
        scm,
        installationId: args.installationId ?? null,
        owner: args.owner,
        name: args.name,
        defaultBranch: args.defaultBranch ?? "main",
        coveredBranchesJson: JSON.stringify(args.coveredBranches ?? []),
        rulesMd: args.rulesMd ?? null,
        status: "active" as const,
        createdAt: ts,
        updatedAt: ts,
      };
      try {
        db.insert(reviewReposTable).values(row).run();
      } catch (err) {
        // Concurrent connect of the same (scm,owner,name,user_id): the loser of
        // the race re-reads the winner's row instead of throwing.
        if (isUniqueViolation(err)) {
          const winner = db
            .select()
            .from(reviewReposTable)
            .where(
              and(
                eq(reviewReposTable.scm, scm),
                eq(reviewReposTable.owner, args.owner),
                eq(reviewReposTable.name, args.name),
                eq(reviewReposTable.userId, args.userId),
              ),
            )
            .get();
          if (winner) return winner as ReviewRepo;
        }
        throw err;
      }
      await emit(
        "review_repo_connected",
        "success",
        { repo: `${args.owner}/${args.name}`, scm, repo_id: id },
        args.userId,
      );
      return row as ReviewRepo;
    },

    async getRepoByFullName(scm, owner, name) {
      const row = db
        .select()
        .from(reviewReposTable)
        .where(
          and(
            eq(reviewReposTable.scm, scm as "github"),
            eq(reviewReposTable.owner, owner),
            eq(reviewReposTable.name, name),
          ),
        )
        .get();
      return (row as ReviewRepo) ?? null;
    },

    async getRepoByInstallation(scm, installationId, owner, name) {
      // Filter on the SIGNED installation id; assert the slug matches so a
      // webhook for installation X can only ever resolve installation X's
      // genuinely-connected repo row.
      const row = db
        .select()
        .from(reviewReposTable)
        .where(
          and(
            eq(reviewReposTable.scm, scm as "github"),
            eq(reviewReposTable.installationId, installationId),
            eq(reviewReposTable.owner, owner),
            eq(reviewReposTable.name, name),
          ),
        )
        .get();
      return (row as ReviewRepo) ?? null;
    },

    async getRepo(id) {
      const row = db
        .select()
        .from(reviewReposTable)
        .where(eq(reviewReposTable.id, id))
        .get();
      return (row as ReviewRepo) ?? null;
    },

    async listReposByUser(userId) {
      return db
        .select()
        .from(reviewReposTable)
        .where(eq(reviewReposTable.userId, userId))
        .orderBy(desc(reviewReposTable.createdAt))
        .all() as ReviewRepo[];
    },

    async createReview(args) {
      const ts = clock();
      const id = ulid(ts);
      const row = {
        id,
        repoId: args.repoId ?? null,
        userId: args.userId ?? null,
        kind: args.kind,
        prNumber: args.prNumber ?? null,
        headSha: args.headSha ?? null,
        baseSha: args.baseSha ?? null,
        commitRef: args.commitRef ?? null,
        status: "queued" as const,
        score0to5: null,
        summaryMd: null,
        githubReviewId: null,
        findingsCount: 0,
        startedAt: null,
        completedAt: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(reviewsTable).values(row).run();
      return row as Review;
    },

    async createQueuedReviewWithJob(args, jobType, dedup) {
      const ts = clock();
      const reviewId = ulid(ts);
      const jobId = ulid(ts + 1); // distinct id even with a frozen clock
      const reviewRow = {
        id: reviewId,
        repoId: args.repoId ?? null,
        userId: args.userId ?? null,
        kind: args.kind,
        prNumber: args.prNumber ?? null,
        headSha: args.headSha ?? null,
        baseSha: args.baseSha ?? null,
        commitRef: args.commitRef ?? null,
        status: "queued" as const,
        score0to5: null,
        summaryMd: null,
        githubReviewId: null,
        findingsCount: 0,
        startedAt: null,
        completedAt: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      };
      try {
        await withTx(db, (tx) => {
          // Record the webhook delivery FIRST, in the same tx — its UNIQUE
          // collision aborts the whole tx (no orphan review/job), and a crash
          // before COMMIT rolls it back too so GitHub's retry re-processes.
          if (dedup) {
            tx.insert(webhookDedupTable)
              .values({
                id: dedup.id,
                webhookKind: dedup.webhookKind,
                dedupKey: dedup.dedupKey,
                receivedAt: dedup.receivedAt,
                metadataJson: dedup.metadataJson,
              })
              .run();
          }
          tx.insert(reviewsTable).values(reviewRow).run();
          tx.insert(jobsTable)
            .values({
              id: jobId,
              type: jobType,
              payloadJson: JSON.stringify({ type: jobType, reviewId }),
              status: "pending",
              scheduledAt: ts,
              attempts: 0,
              lastError: null,
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        });
      } catch (err) {
        // A duplicate webhook delivery (already-seen dedup key) is expected,
        // not an error: the tx rolled back, so signal the route to 200.
        if (dedup && isUniqueViolation(err)) {
          return { review: reviewRow as Review, jobId, duplicate: true };
        }
        throw err;
      }
      return { review: reviewRow as Review, jobId, duplicate: false };
    },

    async markReviewRunning(id) {
      const ts = clock();
      db.update(reviewsTable)
        .set({ status: "running", startedAt: ts, updatedAt: ts })
        .where(eq(reviewsTable.id, id))
        .run();
      const review = db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.id, id))
        .get() as Review;
      await emit(
        review.kind === "whitebox" ? "whitebox_scan_started" : "review_started",
        "success",
        { review_id: id, kind: review.kind, pr_number: review.prNumber },
        review.userId,
      );
      return review;
    },

    async finalizeReview(id, result) {
      const ts = clock();
      await withTx(db, (tx) => {
        // Idempotent re-finalize: clear prior findings for this review.
        tx.delete(reviewFindingsTable)
          .where(eq(reviewFindingsTable.reviewId, id))
          .run();
        for (const f of result.findings) {
          tx.insert(reviewFindingsTable)
            .values({
              id: ulid(ts),
              reviewId: id,
              fingerprint: f.fingerprint,
              filePath: f.filePath,
              startLine: f.startLine ?? null,
              endLine: f.endLine ?? null,
              side: f.side,
              severity: f.severity,
              cweJson: JSON.stringify(f.cwe ?? []),
              cvssVector: f.cvssVector ?? null,
              cvssScore: f.cvssScore ?? null,
              confidence: f.confidence ?? null,
              reachable: f.reachable === undefined ? null : f.reachable ? 1 : 0,
              category: f.category ?? null,
              title: f.title,
              rationaleMd: f.rationaleMd,
              pocMd: f.pocMd ?? null,
              fixPromptMd: f.fixPromptMd ?? null,
              source: f.source,
              lifecycleState: "open",
              createdAt: ts,
            })
            .run();
        }
        tx.update(reviewsTable)
          .set({
            status: "completed",
            score0to5: result.score0to5,
            summaryMd: result.summaryMd,
            findingsCount: result.findings.length,
            completedAt: ts,
            updatedAt: ts,
          })
          .where(eq(reviewsTable.id, id))
          .run();
      });
      const review = db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.id, id))
        .get() as Review;
      await emit(
        review.kind === "whitebox"
          ? "whitebox_scan_completed"
          : "review_completed",
        "success",
        {
          review_id: id,
          kind: review.kind,
          score_0_5: result.score0to5,
          findings: result.findings.length,
        },
        review.userId,
      );
      return review;
    },

    async failReview(id, error) {
      const ts = clock();
      db.update(reviewsTable)
        .set({ status: "failed", error, completedAt: ts, updatedAt: ts })
        .where(eq(reviewsTable.id, id))
        .run();
      const review = db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.id, id))
        .get() as Review;
      await emit(
        "review_failed",
        "failure",
        { review_id: id, kind: review.kind, error },
        review.userId,
      );
      return review;
    },

    async getReview(id) {
      const row = db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.id, id))
        .get();
      return (row as Review) ?? null;
    },

    async listReviewsByRepo(repoId) {
      return db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.repoId, repoId))
        .orderBy(desc(reviewsTable.createdAt))
        .all() as Review[];
    },

    async listReviewsByUser(userId) {
      return db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.userId, userId))
        .orderBy(desc(reviewsTable.createdAt))
        .all() as Review[];
    },

    async getReviewFindings(reviewId) {
      return db
        .select()
        .from(reviewFindingsTable)
        .where(eq(reviewFindingsTable.reviewId, reviewId))
        .all() as ReviewFindingRow[];
    },

    async countFindingsByReviewIds(reviewIds) {
      if (reviewIds.length === 0) return {};
      const rows = db
        .select({
          reviewId: reviewFindingsTable.reviewId,
          n: count(),
        })
        .from(reviewFindingsTable)
        .where(inArray(reviewFindingsTable.reviewId, reviewIds))
        .groupBy(reviewFindingsTable.reviewId)
        .all() as Array<{ reviewId: string; n: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.reviewId] = r.n;
      return out;
    },

    async upsertThread(args) {
      const ts = clock();
      const existing = db
        .select()
        .from(reviewThreadsTable)
        .where(
          and(
            eq(reviewThreadsTable.repoId, args.repoId),
            eq(reviewThreadsTable.fingerprint, args.fingerprint),
            eq(reviewThreadsTable.isResolved, 0),
          ),
        )
        .get();
      if (existing) {
        db.update(reviewThreadsTable)
          .set({
            githubThreadId:
              args.githubThreadId === undefined
                ? existing.githubThreadId
                : args.githubThreadId,
            githubCommentId:
              args.githubCommentId === undefined
                ? existing.githubCommentId
                : args.githubCommentId,
            updatedAt: ts,
          })
          .where(eq(reviewThreadsTable.id, existing.id))
          .run();
        return db
          .select()
          .from(reviewThreadsTable)
          .where(eq(reviewThreadsTable.id, existing.id))
          .get() as ReviewThread;
      }
      const id = ulid(ts);
      const row = {
        id,
        reviewId: args.reviewId,
        repoId: args.repoId,
        fingerprint: args.fingerprint,
        githubThreadId: args.githubThreadId ?? null,
        githubCommentId: args.githubCommentId ?? null,
        isResolved: 0,
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(reviewThreadsTable).values(row).run();
      return row as ReviewThread;
    },

    async getOpenThread(repoId, fingerprint) {
      const row = db
        .select()
        .from(reviewThreadsTable)
        .where(
          and(
            eq(reviewThreadsTable.repoId, repoId),
            eq(reviewThreadsTable.fingerprint, fingerprint),
            eq(reviewThreadsTable.isResolved, 0),
          ),
        )
        .get();
      return (row as ReviewThread) ?? null;
    },

    async markThreadResolved(id) {
      const ts = clock();
      db.update(reviewThreadsTable)
        .set({ isResolved: 1, updatedAt: ts })
        .where(eq(reviewThreadsTable.id, id))
        .run();
    },

    async recordFeedback(args) {
      const ts = clock();
      const id = ulid(ts);
      const row = {
        id,
        repoId: args.repoId,
        fingerprint: args.fingerprint ?? null,
        signal: args.signal,
        commentText: args.commentText ?? null,
        embeddingJson: args.embeddingJson ?? null,
        createdAt: ts,
      };
      db.insert(reviewFeedbackTable).values(row).run();
      return row as ReviewFeedback;
    },

    async listFeedback(repoId, signal) {
      const where = signal
        ? and(
            eq(reviewFeedbackTable.repoId, repoId),
            eq(reviewFeedbackTable.signal, signal),
          )
        : eq(reviewFeedbackTable.repoId, repoId);
      return db
        .select()
        .from(reviewFeedbackTable)
        .where(where)
        .orderBy(desc(reviewFeedbackTable.createdAt))
        .all() as ReviewFeedback[];
    },

    // -------------------------------------------------------------------------
    // Installations CRUD (T005/T006 — feature 004: Sthrip PR Review)
    // -------------------------------------------------------------------------

    async upsertInstallation(args) {
      const scm = args.scm ?? "github";
      const ts = clock();

      // USER-SCOPED lookup: an installation row's ownership is fixed at creation.
      // The UNIQUE index is (scm, installationId) — one external installation
      // maps to exactly ONE internal row and ONE owning user.
      const existing = db
        .select()
        .from(installationsTable)
        .where(
          and(
            eq(installationsTable.scm, scm),
            eq(installationsTable.installationId, args.installationId),
          ),
        )
        .get();

      if (existing) {
        // Update mutable fields; userId (ownership) is immutable after creation.
        db.update(installationsTable)
          .set({
            accountLogin: args.accountLogin,
            accountType: args.accountType,
            repositorySelection: args.repositorySelection,
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.setupAction !== undefined
              ? { setupAction: args.setupAction }
              : {}),
            updatedAt: ts,
          })
          .where(eq(installationsTable.id, existing.id))
          .run();
        const updated = db
          .select()
          .from(installationsTable)
          .where(eq(installationsTable.id, existing.id))
          .get();
        return updated as Installation;
      }

      const id = ulid(ts);
      const row = {
        id,
        userId: args.userId,
        scm,
        installationId: args.installationId,
        accountLogin: args.accountLogin,
        accountType: args.accountType,
        repositorySelection: args.repositorySelection,
        status: (args.status ?? "active") as "active" | "suspended" | "deleted",
        ...(args.setupAction !== undefined
          ? { setupAction: args.setupAction }
          : { setupAction: null }),
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(installationsTable).values(row).run();

      await emit(
        "github_app_installed",
        "success",
        {
          installation_id: args.installationId,
          scm,
          account_login: args.accountLogin,
          account_type: args.accountType,
        },
        args.userId,
      );

      return row as Installation;
    },

    async getInstallationByGithubId(scm, installationId) {
      const row = db
        .select()
        .from(installationsTable)
        .where(
          and(
            eq(installationsTable.scm, scm),
            eq(installationsTable.installationId, installationId),
          ),
        )
        .get();
      return (row as Installation) ?? null;
    },

    async getInstallationsForUser(userId) {
      return db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.userId, userId))
        .orderBy(desc(installationsTable.createdAt))
        .all() as Installation[];
    },

    async markInstallationDeleted(installationId) {
      const ts = clock();

      // Resolve the row first so we have the PK (for cascade) and userId (for audit).
      const existing = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.installationId, installationId))
        .get();
      if (!existing) return;

      // Cascade-disable all review_repos linked to this installation row.
      // We match on installationRowId (the FK to installations.id) which is
      // set when a repo is connected via this installation.
      db.update(reviewReposTable)
        .set({ enabled: 0, updatedAt: ts })
        .where(eq(reviewReposTable.installationRowId, existing.id))
        .run();

      db.update(installationsTable)
        .set({ status: "deleted", updatedAt: ts })
        .where(eq(installationsTable.id, existing.id))
        .run();

      await emit(
        "github_app_uninstalled",
        "success",
        {
          installation_id: installationId,
          scm: existing.scm,
          account_login: existing.accountLogin,
        },
        existing.userId,
      );
    },

    async setInstallationStatus(installationId, status) {
      const ts = clock();

      const existing = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.installationId, installationId))
        .get();
      if (!existing) {
        throw new Error(
          `setInstallationStatus: installation not found (id=${installationId})`,
        );
      }

      db.update(installationsTable)
        .set({ status, updatedAt: ts })
        .where(eq(installationsTable.id, existing.id))
        .run();

      const updated = db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.id, existing.id))
        .get() as Installation;

      if (status === "suspended") {
        await emit(
          "github_app_suspended",
          "success",
          {
            installation_id: installationId,
            scm: existing.scm,
            account_login: existing.accountLogin,
          },
          existing.userId,
        );
      }

      return updated;
    },
  };
}
