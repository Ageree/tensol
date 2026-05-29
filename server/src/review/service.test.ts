/**
 * Tests for the review persistence service (003-whitebox).
 * In-memory bun:sqlite with all migrations applied (mirrors the repo's
 * scan-orders test harness).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, type DB } from "../db/client.ts";
import {
  reviews as reviewsTable,
  reviewFindings as reviewFindingsTable,
  reviewThreads as reviewThreadsTable,
  reviewRepos as reviewReposTable,
  installations as installationsTable,
  auditLog as auditLogTable,
} from "../db/schema.ts";
import { createReviewService } from "./service.ts";
import type { ReviewResult } from "./types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-review-service-0123456789abcdef0123456789abcdef";

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

let clockNow = 1_700_000_000_000;
const clock = () => clockNow++;

function makeSvc(db: DB) {
  return createReviewService({ db, auditKey: KEY, now: clock });
}

async function seedUser(db: DB, id = "user_1"): Promise<string> {
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run(id, `${id}@x.io`, clockNow);
  return id;
}

const sampleResult = (): ReviewResult => ({
  kind: "pr",
  score0to5: 2,
  summaryMd: "Found 1 high finding.",
  findings: [
    {
      fingerprint: "abc123def4567890",
      filePath: "src/db.ts",
      startLine: 42,
      endLine: 42,
      side: "RIGHT",
      severity: "high",
      cwe: ["CWE-89"],
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      cvssScore: 9.8,
      confidence: "high",
      reachable: true,
      category: "SQL Injection",
      title: "SQLi in query builder",
      rationaleMd: "User input flows unparameterized into the query.",
      pocMd: "`' OR 1=1--`",
      fixPromptMd: "Use parameterized queries.",
      source: "llm",
    },
  ],
});

describe("review service", () => {
  let db: DB;
  beforeEach(async () => {
    db = freshMemDb();
    await seedUser(db);
  });

  test("upsertRepo creates then updates idempotently by (scm,owner,name)", async () => {
    const svc = makeSvc(db);
    const r1 = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
      installationId: "111",
      defaultBranch: "main",
    });
    expect(r1.owner).toBe("acme");
    const r2 = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
      installationId: "222",
    });
    expect(r2.id).toBe(r1.id);
    expect(r2.installationId).toBe("222");
    const found = await svc.getRepoByFullName("github", "acme", "app");
    expect(found?.id).toBe(r1.id);
  });

  test("createReview → markRunning → finalize persists findings + score + audit", async () => {
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
    });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "user_1",
      kind: "pr",
      prNumber: 7,
      headSha: "deadbeef",
    });
    expect(review.status).toBe("queued");

    await svc.markReviewRunning(review.id);
    const finalized = await svc.finalizeReview(review.id, sampleResult());
    expect(finalized.status).toBe("completed");
    expect(finalized.score0to5).toBe(2);
    expect(finalized.findingsCount).toBe(1);

    const findings = db
      .select()
      .from(reviewFindingsTable)
      .where(eq(reviewFindingsTable.reviewId, review.id))
      .all();
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("high");
    expect(JSON.parse(findings[0]!.cweJson)).toEqual(["CWE-89"]);

    // review_completed audit row emitted
    const audits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "review_completed"))
      .all();
    expect(audits.length).toBe(1);
  });

  test("finalize is idempotent (re-finalize replaces findings, no dup)", async () => {
    const svc = makeSvc(db);
    const review = await svc.createReview({ kind: "pr", userId: "user_1" });
    await svc.finalizeReview(review.id, sampleResult());
    await svc.finalizeReview(review.id, sampleResult());
    const findings = db
      .select()
      .from(reviewFindingsTable)
      .where(eq(reviewFindingsTable.reviewId, review.id))
      .all();
    expect(findings.length).toBe(1);
  });

  test("failReview marks failed + emits audit", async () => {
    const svc = makeSvc(db);
    const review = await svc.createReview({ kind: "whitebox", userId: "user_1" });
    const failed = await svc.failReview(review.id, "clone failed");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("clone failed");
    const audits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "review_failed"))
      .all();
    expect(audits.length).toBe(1);
  });

  test("thread upsert dedups by (repoId, fingerprint) and tracks resolution", async () => {
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
    });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "user_1",
      kind: "pr",
      prNumber: 7,
    });
    await svc.upsertThread({
      reviewId: review.id,
      repoId: repo.id,
      fingerprint: "fp1",
      githubThreadId: "T_1",
    });
    const existing = await svc.getOpenThread(repo.id, "fp1");
    expect(existing?.githubThreadId).toBe("T_1");
    await svc.markThreadResolved(existing!.id);
    const afterResolve = await svc.getOpenThread(repo.id, "fp1");
    expect(afterResolve).toBeNull();
    const rows = db
      .select()
      .from(reviewThreadsTable)
      .where(eq(reviewThreadsTable.fingerprint, "fp1"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.isResolved).toBe(1);
  });

  test("recordFeedback stores a row and listDownvoted returns it", async () => {
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
    });
    await svc.recordFeedback({
      repoId: repo.id,
      fingerprint: "fp1",
      signal: "down",
      commentText: "noise",
    });
    const down = await svc.listFeedback(repo.id, "down");
    expect(down.length).toBe(1);
    expect(down[0]!.commentText).toBe("noise");
  });

  test("listReviewsByRepo + getReview + getReviewFindings", async () => {
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme",
      name: "app",
    });
    const r = await svc.createReview({
      repoId: repo.id,
      userId: "user_1",
      kind: "pr",
      prNumber: 1,
    });
    await svc.finalizeReview(r.id, sampleResult());
    const list = await svc.listReviewsByRepo(repo.id);
    expect(list.length).toBe(1);
    const got = await svc.getReview(r.id);
    expect(got?.id).toBe(r.id);
    const fs = await svc.getReviewFindings(r.id);
    expect(fs.length).toBe(1);
    expect(fs[0]!.title).toBe("SQLi in query builder");
  });
});

// ===========================================================================
// T005 / T006 — installations CRUD (feature 004: Sthrip PR Review connect flow)
// ===========================================================================

describe("installations service (T005/T006)", () => {
  let db: DB;
  beforeEach(async () => {
    db = freshMemDb();
    // seed two users for cross-tenant assertions
    await seedUser(db, "user_1");
    await seedUser(db, "user_2");
  });

  // ---------------------------------------------------------------------------
  // upsertInstallation — CREATE
  // ---------------------------------------------------------------------------
  test("upsertInstallation creates a new row and emits github_app_installed audit", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
      setupAction: "install",
    });

    expect(inst.id).toBeTruthy();
    expect(inst.userId).toBe("user_1");
    expect(inst.installationId).toBe("inst_111");
    expect(inst.accountLogin).toBe("acme-org");
    expect(inst.status).toBe("active");

    // Verify row is in DB
    const rows = db.select().from(installationsTable).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.installationId).toBe("inst_111");

    // Verify signed audit was emitted
    const audits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "github_app_installed"))
      .all();
    expect(audits.length).toBe(1);
    expect(audits[0]!.userId).toBe("user_1");
  });

  // ---------------------------------------------------------------------------
  // upsertInstallation — UPSERT (idempotent update by installationId)
  // ---------------------------------------------------------------------------
  test("upsertInstallation updates existing row by (scm, installationId) — no duplicate row", async () => {
    const svc = makeSvc(db);
    const i1 = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });
    const i2 = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "selected", // changed
    });

    expect(i2.id).toBe(i1.id);
    expect(i2.repositorySelection).toBe("selected");

    const rows = db.select().from(installationsTable).all();
    expect(rows.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // getInstallationByGithubId
  // ---------------------------------------------------------------------------
  test("getInstallationByGithubId returns the matching installation or null", async () => {
    const svc = makeSvc(db);
    await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    const found = await svc.getInstallationByGithubId("github", "inst_111");
    expect(found).not.toBeNull();
    expect(found!.accountLogin).toBe("acme-org");

    const missing = await svc.getInstallationByGithubId("github", "does_not_exist");
    expect(missing).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // getInstallationsForUser — multi-tenant isolation
  // ---------------------------------------------------------------------------
  test("getInstallationsForUser returns only this user's installations", async () => {
    const svc = makeSvc(db);
    await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });
    await svc.upsertInstallation({
      userId: "user_2",
      scm: "github",
      installationId: "inst_222",
      accountLogin: "other-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    const user1Installs = await svc.getInstallationsForUser("user_1");
    expect(user1Installs.length).toBe(1);
    expect(user1Installs[0]!.installationId).toBe("inst_111");

    const user2Installs = await svc.getInstallationsForUser("user_2");
    expect(user2Installs.length).toBe(1);
    expect(user2Installs[0]!.installationId).toBe("inst_222");
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant: installation belongs to exactly one userId
  // ---------------------------------------------------------------------------
  test("installation is uniquely owned — same (scm,installationId) cannot belong to two users", async () => {
    const svc = makeSvc(db);
    await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    // Attempting to upsert the same installationId for user_2 should either:
    // - throw a UNIQUE constraint (if we don't find and return the existing row) OR
    // - refuse to reassign ownership (the row stays owned by user_1)
    // The invariant: after both calls the row's userId must still be user_1.
    try {
      await svc.upsertInstallation({
        userId: "user_2",
        scm: "github",
        installationId: "inst_111", // same external id
        accountLogin: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
      });
    } catch {
      // A UNIQUE violation is acceptable — the row is immutably owned by user_1
    }

    const rows = db.select().from(installationsTable).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe("user_1");
  });

  // ---------------------------------------------------------------------------
  // markInstallationDeleted — cascade disables review_repos
  // ---------------------------------------------------------------------------
  test("markInstallationDeleted sets status=deleted and emits github_app_uninstalled", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    await svc.markInstallationDeleted(inst.installationId);

    const row = db
      .select()
      .from(installationsTable)
      .where(eq(installationsTable.id, inst.id))
      .get();
    expect(row!.status).toBe("deleted");

    const audits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "github_app_uninstalled"))
      .all();
    expect(audits.length).toBe(1);
    expect(audits[0]!.userId).toBe("user_1");
  });

  test("markInstallationDeleted cascade-disables linked review_repos (sets enabled=0)", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    // Connect a repo linked to this installation
    const repo1 = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme-org",
      name: "repo-a",
      installationId: "inst_111",
    });
    // Link the repo to the installation row
    db.update(reviewReposTable)
      .set({ installationRowId: inst.id })
      .where(eq(reviewReposTable.id, repo1.id))
      .run();

    // Another repo NOT linked to this installation (should remain enabled)
    const repo2 = await svc.upsertRepo({
      userId: "user_1",
      scm: "github",
      owner: "acme-org",
      name: "repo-b",
      installationId: "inst_other",
    });

    await svc.markInstallationDeleted(inst.installationId);

    const r1 = db.select().from(reviewReposTable).where(eq(reviewReposTable.id, repo1.id)).get();
    expect(r1!.enabled).toBe(0);

    // repo2 is NOT linked to this installation — must remain enabled
    const r2 = db.select().from(reviewReposTable).where(eq(reviewReposTable.id, repo2.id)).get();
    expect(r2!.enabled).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // setInstallationStatus — suspend / unsuspend
  // ---------------------------------------------------------------------------
  test("setInstallationStatus(suspended) updates status and emits github_app_suspended", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    await svc.setInstallationStatus(inst.installationId, "suspended");

    const row = db
      .select()
      .from(installationsTable)
      .where(eq(installationsTable.id, inst.id))
      .get();
    expect(row!.status).toBe("suspended");

    const audits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "github_app_suspended"))
      .all();
    expect(audits.length).toBe(1);
    expect(audits[0]!.userId).toBe("user_1");
  });

  test("setInstallationStatus(active) unsuspends without emitting a second suspended audit", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_111",
      accountLogin: "acme-org",
      accountType: "Organization",
      repositorySelection: "all",
    });

    await svc.setInstallationStatus(inst.installationId, "suspended");
    await svc.setInstallationStatus(inst.installationId, "active");

    const row = db
      .select()
      .from(installationsTable)
      .where(eq(installationsTable.id, inst.id))
      .get();
    expect(row!.status).toBe("active");

    // Only ONE suspended audit (for the suspend call)
    const suspendedAudits = db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.event, "github_app_suspended"))
      .all();
    expect(suspendedAudits.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Verify audit chain integrity (prev_signature linkage)
  // ---------------------------------------------------------------------------
  test("audit chain: each row's prev_signature matches the preceding row's signature", async () => {
    const svc = makeSvc(db);
    const inst = await svc.upsertInstallation({
      userId: "user_1",
      scm: "github",
      installationId: "inst_chain",
      accountLogin: "chain-org",
      accountType: "Organization",
      repositorySelection: "all",
    });
    await svc.setInstallationStatus(inst.installationId, "suspended");
    await svc.markInstallationDeleted(inst.installationId);

    const allAudits = db
      .select()
      .from(auditLogTable)
      .all()
      .sort((a, b) => a.id - b.id);

    for (let i = 1; i < allAudits.length; i++) {
      const prev = allAudits[i - 1]!;
      const curr = allAudits[i]!;
      expect(curr.prevSignature).toBe(prev.signature);
    }
  });
});
