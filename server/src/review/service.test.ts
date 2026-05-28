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
