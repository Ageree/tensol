/**
 * 003-whitebox / 004-sthrip-pr-review — review persistence service.
 *
 * Owns all DB writes for the review domain (repos / reviews / findings /
 * threads / feedback / suppressions) and emits the signed audit rows
 * (Constitution X: audit emission lives in the service, not the route).
 * Mirrors the patterns in `findings/service.ts` + `scan-orders/service.ts`.
 *
 * The signed-audit writer (`emitSignedAudit`) owns its own BEGIN IMMEDIATE
 * transaction, so it is always called OUTSIDE `withTx` blocks (bun:sqlite
 * forbids nested BEGINs — same rule as the webhook handlers).
 *
 * Wave-3 file-size refactor: installations CRUD + Wave-2 repo-settings methods
 * are extracted to `service-installations.ts`. This file re-exports them as a
 * thin barrel to keep both files under 800 lines while keeping the
 * `ReviewService` interface + factory stable for consumers.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { emitSignedAudit } from "../audit/emit.ts";
import type { DB } from "../db/client.ts";
import { withTx } from "../db/client.ts";
import {
  jobs as jobsTable,
  reviewFeedback as reviewFeedbackTable,
  reviewFindings as reviewFindingsTable,
  reviewRepos as reviewReposTable,
  reviewSuppressions as reviewSuppressionsTable,
  reviewThreads as reviewThreadsTable,
  reviews as reviewsTable,
  webhookDedup as webhookDedupTable,
  type Installation,
  type Review,
  type ReviewFeedback,
  type ReviewFinding as ReviewFindingRow,
  type ReviewRepo,
  type ReviewSuppression,
  type ReviewThread,
} from "../db/schema.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import { NEVER_SUPPRESS } from "./learning.ts";
import type { ReviewKind, ReviewResult } from "./types.ts";
import {
  createInstallationMethods,
  type UpsertInstallationArgs,
  type UpdateRepoSettingsArgs,
  type ReconcileInstallationReposArgs,
  type SetReposEnabledBySlugsArgs,
} from "./service-installations.ts";

// Re-export installation-module arg types so consumers import from one place.
export type {
  UpsertInstallationArgs,
  UpdateRepoSettingsArgs,
  ReconcileInstallationReposArgs,
  SetReposEnabledBySlugsArgs,
} from "./service-installations.ts";

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

export interface ResolveThreadByFingerprintArgs {
  readonly repoId: string;
  readonly fingerprint: string;
}

export interface WriteSuppressionArgs {
  readonly repoId: string;
  readonly category: string;
  readonly reason: "ignored_n_times" | "manual";
  readonly ignoreCount: number;
}

export interface ReviewService {
  // Core repo CRUD
  upsertRepo(args: UpsertRepoArgs): Promise<ReviewRepo>;
  getRepoByFullName(scm: string, owner: string, name: string): Promise<ReviewRepo | null>;
  /** Resolve by SIGNED installation id — the only cross-tenant-safe lookup. */
  getRepoByInstallation(scm: string, installationId: string, owner: string, name: string): Promise<ReviewRepo | null>;
  getRepo(id: string): Promise<ReviewRepo | null>;
  listReposByUser(userId: string): Promise<ReviewRepo[]>;

  // Review lifecycle
  createReview(args: CreateReviewArgs): Promise<Review>;
  /** Atomic review+job insert with optional dedup; duplicate→{duplicate:true}. */
  createQueuedReviewWithJob(
    args: CreateReviewArgs,
    jobType: "pr_review" | "whitebox_scan",
    dedup?: { id: string; webhookKind: string; dedupKey: string; receivedAt: number; metadataJson: string },
  ): Promise<{ review: Review; jobId: string; duplicate: boolean }>;
  markReviewRunning(id: string): Promise<Review>;
  finalizeReview(id: string, result: ReviewResult): Promise<Review>;
  failReview(id: string, error: string): Promise<Review>;
  getReview(id: string): Promise<Review | null>;
  listReviewsByRepo(repoId: string): Promise<Review[]>;
  listReviewsByUser(userId: string): Promise<Review[]>;
  getReviewFindings(reviewId: string): Promise<ReviewFindingRow[]>;
  countFindingsByReviewIds(reviewIds: string[]): Promise<Record<string, number>>;

  // Threads + feedback
  upsertThread(args: UpsertThreadArgs): Promise<ReviewThread>;
  getOpenThread(repoId: string, fingerprint: string): Promise<ReviewThread | null>;
  markThreadResolved(id: string): Promise<void>;
  recordFeedback(args: RecordFeedbackArgs): Promise<ReviewFeedback>;
  listFeedback(repoId: string, signal?: "up" | "down" | "addressed" | "ignored"): Promise<ReviewFeedback[]>;

  // Installations CRUD (T005/T006)
  upsertInstallation(args: UpsertInstallationArgs): Promise<Installation>;
  getInstallationByGithubId(scm: string, installationId: string): Promise<Installation | null>;
  getInstallationsForUser(userId: string): Promise<Installation[]>;
  markInstallationDeleted(installationId: string): Promise<void>;
  setInstallationStatus(installationId: string, status: "active" | "suspended"): Promise<Installation>;
  getInstallationByRowId(id: string): Promise<Installation | null>;

  // Wave-2 repo-settings (T013–T016)
  /** Owner-scoped; returns null if userId doesn't match. */
  updateRepoSettings(args: UpdateRepoSettingsArgs): Promise<ReviewRepo | null>;
  reconcileInstallationRepos(args: ReconcileInstallationReposArgs): Promise<void>;
  setReposEnabledBySlugs(args: SetReposEnabledBySlugsArgs): Promise<void>;

  // Wave-3 (T042, T045)
  /** Mark thread resolved + set finding lifecycleState='resolved'. No-op when absent. */
  resolveThreadByFingerprint(args: ResolveThreadByFingerprintArgs): Promise<void>;
  /** Upsert suppression; THROWS for security/correctness (FR-024 invariant). */
  writeSuppression(args: WriteSuppressionArgs): Promise<ReviewSuppression>;
  listSuppressions(repoId: string): Promise<ReviewSuppression[]>;
  /** True when a running review exists for (repoId, prNumber) — concurrency guard. */
  hasRunningReview(repoId: string, prNumber: number): Promise<boolean>;
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

  // Delegate installations CRUD to the extracted module.
  const installationMethods = createInstallationMethods(db, clock, emit);

  // upsertRepo is defined as a standalone function so reconcileInstallationRepos
  // can call it without needing a `this` reference.
  async function upsertRepo(args: UpsertRepoArgs): Promise<ReviewRepo> {
    const scm = args.scm ?? "github";
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
  }

  return {
    upsertRepo,

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
      const jobId = ulid(ts + 1);
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
              // Wave-3: persist verificationStatus + reachabilityEvidenceMd
              verificationStatus: f.verificationStatus ?? "unverified",
              ...(f.reachabilityEvidenceMd !== undefined
                ? { reachabilityEvidenceMd: f.reachabilityEvidenceMd }
                : { reachabilityEvidenceMd: null }),
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
    // Installations CRUD (delegated to service-installations.ts)
    // -------------------------------------------------------------------------
    upsertInstallation: (args) => installationMethods.upsertInstallation(args),
    getInstallationByGithubId: (scm, id) =>
      installationMethods.getInstallationByGithubId(scm, id),
    getInstallationsForUser: (userId) =>
      installationMethods.getInstallationsForUser(userId),
    markInstallationDeleted: (id) =>
      installationMethods.markInstallationDeleted(id),
    setInstallationStatus: (id, status) =>
      installationMethods.setInstallationStatus(id, status),
    getInstallationByRowId: (id) =>
      installationMethods.getInstallationByRowId(id),
    updateRepoSettings: (args) =>
      installationMethods.updateRepoSettings(args),
    reconcileInstallationRepos: (args) =>
      installationMethods.reconcileInstallationRepos(args, upsertRepo),
    setReposEnabledBySlugs: (args) =>
      installationMethods.setReposEnabledBySlugs(args),

    // -------------------------------------------------------------------------
    // Wave-3: resolveThreadByFingerprint (T042)
    // -------------------------------------------------------------------------
    async resolveThreadByFingerprint(args) {
      const ts = clock();

      // Find the open thread for this (repoId, fingerprint).
      const thread = db
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

      if (!thread) return; // No open thread — no-op.

      // Mark the thread resolved.
      db.update(reviewThreadsTable)
        .set({ isResolved: 1, updatedAt: ts })
        .where(eq(reviewThreadsTable.id, thread.id))
        .run();

      // Set the matching findings' lifecycleState to 'resolved'.
      db.update(reviewFindingsTable)
        .set({ lifecycleState: "resolved" })
        .where(eq(reviewFindingsTable.fingerprint, args.fingerprint))
        .run();

      await emit(
        "review_thread_resolved",
        "success",
        {
          thread_id: thread.id,
          repo_id: args.repoId,
          fingerprint: args.fingerprint,
        },
        null,
      );
    },

    // -------------------------------------------------------------------------
    // Wave-3: writeSuppression + listSuppressions (T045)
    // -------------------------------------------------------------------------
    async writeSuppression(args) {
      // FR-024 hard invariant: security and correctness are NEVER suppressed.
      if (NEVER_SUPPRESS.has(args.category)) {
        throw new Error(
          `writeSuppression: cannot suppress category '${args.category}' — this category is protected by the NEVER_SUPPRESS invariant (FR-024).`,
        );
      }

      const ts = clock();

      // Attempt an insert; on UNIQUE violation (repoId, category), fall through
      // to update the existing row.
      const existing = db
        .select()
        .from(reviewSuppressionsTable)
        .where(
          and(
            eq(reviewSuppressionsTable.repoId, args.repoId),
            eq(reviewSuppressionsTable.category, args.category),
          ),
        )
        .get();

      if (existing) {
        db.update(reviewSuppressionsTable)
          .set({
            reason: args.reason,
            ignoreCount: args.ignoreCount,
            updatedAt: ts,
          })
          .where(eq(reviewSuppressionsTable.id, existing.id))
          .run();
        const updated = db
          .select()
          .from(reviewSuppressionsTable)
          .where(eq(reviewSuppressionsTable.id, existing.id))
          .get() as ReviewSuppression;
        await emit(
          "review_category_suppressed",
          "success",
          {
            repo_id: args.repoId,
            category: args.category,
            reason: args.reason,
            ignore_count: args.ignoreCount,
          },
          null,
        );
        return updated;
      }

      const id = ulid(ts);
      const row = {
        id,
        repoId: args.repoId,
        category: args.category,
        reason: args.reason,
        ignoreCount: args.ignoreCount,
        createdAt: ts,
        updatedAt: ts,
      };
      db.insert(reviewSuppressionsTable).values(row).run();

      await emit(
        "review_category_suppressed",
        "success",
        {
          repo_id: args.repoId,
          category: args.category,
          reason: args.reason,
          ignore_count: args.ignoreCount,
        },
        null,
      );

      return row as ReviewSuppression;
    },

    async listSuppressions(repoId) {
      return db
        .select()
        .from(reviewSuppressionsTable)
        .where(eq(reviewSuppressionsTable.repoId, repoId))
        .orderBy(desc(reviewSuppressionsTable.createdAt))
        .all() as ReviewSuppression[];
    },

    // -------------------------------------------------------------------------
    // Wave-3: hasRunningReview (T042 concurrency guard)
    // -------------------------------------------------------------------------
    async hasRunningReview(repoId, prNumber) {
      const row = db
        .select()
        .from(reviewsTable)
        .where(
          and(
            eq(reviewsTable.repoId, repoId),
            eq(reviewsTable.prNumber, prNumber),
            eq(reviewsTable.status, "running"),
          ),
        )
        .get();
      return row !== undefined && row !== null;
    },
  };
}
