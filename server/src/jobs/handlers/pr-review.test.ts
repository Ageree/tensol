/**
 * pr_review + whitebox_scan handler tests — end-to-end with fakes + in-memory DB.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb, type DB } from "../../db/client.ts";
import { createReviewService } from "../../review/service.ts";
import { FakeGitHubClient, type GitHubClient } from "../../review/github/client.ts";
import { FakeLlmClient } from "../../review/reviewer.ts";
import { FakeSastRunner } from "../../review/sast/runner.ts";
import { FakeRepoFetcher } from "../../review/repo-fetch.ts";
import type { DiffFile, RawFinding } from "../../review/types.ts";
import { createPrReviewHandler } from "./pr-review.ts";
import { createWhiteboxScanHandler } from "./whitebox-scan.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "migrations");
const KEY = "test-key-pr-review-handler-0123456789abcdef0123456789abcdef";

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

let clockNow = 1_700_000_000_000;
const clock = () => clockNow++;

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  // Seed the test users referenced by review_repos.user_id / reviews.user_id.
  seedUser(db, "user_1");
  seedUser(db, "u");
  return db;
}

function makeSvc(db: DB) {
  return createReviewService({ db, auditKey: KEY, now: clock });
}

function seedUser(db: DB, id: string): void {
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run(id, `${id}@x.io`, clockNow);
}

const sqliFile: DiffFile = {
  path: "src/db.ts",
  status: "modified",
  patch: [
    "@@ -10,3 +10,4 @@ function q(req) {",
    " const id = req.query.id;",
    '+const sql = "SELECT * FROM users WHERE id = " + id;',
    "+return db.exec(sql);",
    " }",
  ].join("\n"),
};

function sqliResponder(): string {
  return JSON.stringify({
    summary: "Found a SQL injection.",
    verdicts: [
      {
        candidate_id: "diff:src/db.ts:11:0",
        file_path: "src/db.ts",
        start_line: 11,
        end_line: 12,
        is_vulnerability: true,
        category: "SQL Injection",
        cwe: ["CWE-89"],
        rationale_md: "req.query.id flows unparameterized into db.exec.",
        reachable: true,
        confidence: "high",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
        title: "SQL injection in db.ts",
      },
    ],
  });
}

describe("createPrReviewHandler", () => {
  test("reviews a PR, posts a batched review + check-run, persists findings", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "inst-1",
    });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "user_1",
      kind: "pr",
      prNumber: 7,
      headSha: "deadbeef",
    });

    const github = new FakeGitHubClient({ files: [sqliFile] });
    const handler = createPrReviewHandler({
      service: svc,
      github,
      llm: new FakeLlmClient(sqliResponder),
    });

    await handler("job-1", { reviewId: review.id });

    // GitHub effects
    expect(github.getFilesCalls.length).toBe(1);
    expect(github.postReviewCalls.length).toBe(1);
    expect(github.postReviewCalls[0]!.comments.length).toBe(1);
    expect(github.createCheckRunCalls.length).toBe(1);
    expect(github.createCheckRunCalls[0]!.title).toBe("Sthrip 0/5");
    expect(github.createCheckRunCalls[0]!.conclusion).toBe("failure");

    // Persistence
    const finalized = await svc.getReview(review.id);
    expect(finalized!.status).toBe("completed");
    expect(finalized!.score0to5).toBe(0);
    expect(finalized!.findingsCount).toBe(1);
    const findings = await svc.getReviewFindings(review.id);
    expect(findings.length).toBe(1);
    expect(findings[0]!.severity).toBe("critical");

    // Thread mapping recorded for the posted fingerprint
    const open = await svc.getOpenThread(repo.id, findings[0]!.fingerprint);
    expect(open).not.toBeNull();
  });

  test("re-review skips findings that already have an open thread", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha1",
    });
    const github = new FakeGitHubClient({ files: [sqliFile] });
    const handler = createPrReviewHandler({
      service: svc,
      github,
      llm: new FakeLlmClient(sqliResponder),
    });
    await handler("job-1", { reviewId: review.id });
    expect(github.postReviewCalls.length).toBe(1);

    // Second review of the same PR (synchronize) — same finding fingerprint.
    const review2 = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha2",
    });
    await handler("job-2", { reviewId: review2.id });
    // No NEW inline comments — the finding already has an open thread.
    expect(github.postReviewCalls.length).toBe(1);
    // But a fresh check-run still runs (the gate is always posted).
    expect(github.createCheckRunCalls.length).toBe(2);
  });

  test("#8 does NOT re-post a finding whose fingerprint already exists in a GitHub comment", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });

    // First run to learn the deterministic fingerprint the engine produces.
    const review1 = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha1",
    });
    const g1 = new FakeGitHubClient({ files: [sqliFile] });
    const handler1 = createPrReviewHandler({
      service: svc,
      github: g1,
      llm: new FakeLlmClient(sqliResponder),
    });
    await handler1("job-1", { reviewId: review1.id });
    const fp = (await svc.getReviewFindings(review1.id))[0]!.fingerprint;

    // Simulate the at-least-once hazard: the prior post SUCCEEDED on GitHub (the
    // comment carries the hidden tensol:fp marker) but NO local thread row was
    // committed. A fresh review for the same PR must NOT re-post.
    await svc.markThreadResolved(
      (await svc.getOpenThread(repo.id, fp))!.id,
    ); // drop the local fast-path so only GitHub state can dedup
    const review2 = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha2",
    });
    const g2 = new FakeGitHubClient({
      files: [sqliFile],
      existingComments: [{ body: `prior review\n<!-- tensol:fp:${fp} -->` }],
    });
    const handler2 = createPrReviewHandler({
      service: svc,
      github: g2,
      llm: new FakeLlmClient(sqliResponder),
    });
    await handler2("job-2", { reviewId: review2.id });

    expect(g2.listCommentsCalls.length).toBe(1);
    // No inline comments posted — GitHub already has this fingerprint.
    expect(g2.postReviewCalls.length).toBe(0);
    // The merge-gating check-run is still posted (the gate is always set).
    expect(g2.createCheckRunCalls.length).toBe(1);
  });

  test("marks the review failed and rethrows when the repo is missing", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const review = await svc.createReview({
      repoId: null,
      userId: "u",
      kind: "pr",
      prNumber: 1,
      headSha: "x",
    });
    const handler = createPrReviewHandler({
      service: svc,
      github: new FakeGitHubClient(),
      llm: new FakeLlmClient(() => "{}"),
    });
    await expect(handler("job-1", { reviewId: review.id })).rejects.toThrow();
    const after = await svc.getReview(review.id);
    expect(after!.status).toBe("failed");
  });

  test("idempotent: a completed review short-circuits", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha1",
    });
    const github = new FakeGitHubClient({ files: [sqliFile] });
    const handler = createPrReviewHandler({
      service: svc,
      github,
      llm: new FakeLlmClient(sqliResponder),
    });
    await handler("job-1", { reviewId: review.id });
    const calls = github.getFilesCalls.length;
    await handler("job-1-again", { reviewId: review.id });
    expect(github.getFilesCalls.length).toBe(calls); // no second fetch
  });

  test("a transient failure leaves the review re-runnable (retry is NOT a no-op)", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "web" });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 7,
      headSha: "sha1",
    });

    // GitHub client that fails the FIRST fetch (transient) then succeeds.
    let fetchCalls = 0;
    const flaky: GitHubClient = {
      getPullRequestFiles: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new Error("502 Bad Gateway (transient)");
        return [sqliFile];
      },
      listReviewComments: async () => [],
      getFileContents: async () => null,
      postReview: async () => ({ reviewId: "r1" }),
      createCheckRun: async () => ({ checkRunId: "c1" }),
      resolveReviewThread: async () => {},
    };
    const handler = createPrReviewHandler({
      service: svc,
      github: flaky,
      llm: new FakeLlmClient(sqliResponder),
    });

    // Attempt 1 (runner dispatch): transient failure -> review marked failed, rethrown.
    await expect(handler("job-1", { reviewId: review.id })).rejects.toThrow(/transient/);
    expect((await svc.getReview(review.id))!.status).toBe("failed");

    // Attempt 2 (runner retry, attempts < max): must RE-RUN, not short-circuit.
    await handler("job-1", { reviewId: review.id });
    expect(fetchCalls).toBe(2); // proves the retry re-ran the review
    const after = await svc.getReview(review.id);
    expect(after!.status).toBe("completed");
    expect(after!.findingsCount).toBe(1);
  });

  test("rejects a malformed payload", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const handler = createPrReviewHandler({
      service: svc,
      github: new FakeGitHubClient(),
      llm: new FakeLlmClient(() => "{}"),
    });
    await expect(handler("job-1", { nope: true })).rejects.toThrow(/missing reviewId/);
  });
});

describe("createWhiteboxScanHandler", () => {
  test("scans a repo via the fetcher + SAST and persists findings", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "whitebox",
    });

    const raw: RawFinding[] = [
      {
        ruleId: "gitleaks.aws-key",
        source: "secrets",
        filePath: "config.ts",
        startLine: 3,
        message: "AWS key committed",
        cwe: ["CWE-798"],
        snippet: "const k = 'AKIA...'",
      },
    ];
    const responder = () =>
      JSON.stringify({
        summary: "secret",
        verdicts: [
          {
            candidate_id: "sast:secrets:config.ts:3:0",
            file_path: "config.ts",
            start_line: 3,
            is_vulnerability: true,
            category: "Hardcoded Secret",
            cwe: ["CWE-798"],
            rationale_md: "AWS key hardcoded.",
            reachable: true,
            confidence: "verified",
            cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "N", A: "N" },
            title: "Hardcoded AWS key",
          },
        ],
      });

    const fetcher = new FakeRepoFetcher({
      "config.ts": "const k = 'AKIA...'\nexport const x = 1\n",
    });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(responder),
      sastRunner: new FakeSastRunner("gitleaks", raw),
      cloneUrlFor: () => "https://github.com/acme/api.git",
    });

    await handler("job-1", { reviewId: review.id });

    expect(fetcher.calls.length).toBe(1);
    expect(fetcher.calls[0]!.cloneUrl).toContain("acme/api");
    const finalized = await svc.getReview(review.id);
    expect(finalized!.status).toBe("completed");
    expect(finalized!.findingsCount).toBe(1);
    const findings = await svc.getReviewFindings(review.id);
    expect(findings[0]!.category).toBe("Hardcoded Secret");
  });

  test("marks failed + rethrows when cloneUrlFor throws", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher: new FakeRepoFetcher({}),
      llm: new FakeLlmClient(() => "{}"),
      cloneUrlFor: () => {
        throw new Error("no token");
      },
    });
    await expect(handler("job-1", { reviewId: review.id })).rejects.toThrow(/no token/);
    const after = await svc.getReview(review.id);
    expect(after!.status).toBe("failed");
  });

  // F2: exploit-hook auto-trigger wiring.
  const emptyVerdicts = () => JSON.stringify({ summary: "ok", verdicts: [] });

  test("invokes the exploit hook after finalize with installation auth + repoDir", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "u",
      owner: "acme",
      name: "api",
      installationId: "inst-9",
    });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    const calls: Array<{ reviewId: string; authorization: unknown; repoDir?: string }> = [];
    // Inline fetcher that DOES expose a repoDir (FakeRepoFetcher is in-memory and
    // omits it), so we can assert the handler forwards the live checkout path.
    const onDiskFetcher = {
      fetch: async () => ({
        files: [],
        repoDir: "/tmp/fake-checkout",
        cleanup: () => {},
      }),
    } as unknown as FakeRepoFetcher;
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher: onDiskFetcher,
      llm: new FakeLlmClient(emptyVerdicts),
      cloneUrlFor: () => "https://github.com/acme/api.git",
      exploit: async (args) => {
        calls.push(args);
        return [];
      },
    });

    await handler("job-1", { reviewId: review.id });

    expect((await svc.getReview(review.id))!.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reviewId).toBe(review.id);
    expect(calls[0]!.authorization).toEqual({
      kind: "github-installation",
      installationId: "inst-9",
      owner: "acme",
      repo: "api",
    });
    expect(calls[0]!.repoDir).toBe("/tmp/fake-checkout");
  });

  test("does NOT invoke the exploit hook when the repo has no installationId", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" }); // no installationId
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    let called = false;
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher: new FakeRepoFetcher({ "a.ts": "export const x = 1\n" }),
      llm: new FakeLlmClient(emptyVerdicts),
      cloneUrlFor: () => "https://github.com/acme/api.git",
      exploit: async () => {
        called = true;
        return [];
      },
    });

    await handler("job-1", { reviewId: review.id });
    expect((await svc.getReview(review.id))!.status).toBe("completed");
    expect(called).toBe(false);
  });

  test("an exploit-hook throw does not fail the scan", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({
      userId: "u",
      owner: "acme",
      name: "api",
      installationId: "inst-9",
    });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher: new FakeRepoFetcher({ "a.ts": "export const x = 1\n" }),
      llm: new FakeLlmClient(emptyVerdicts),
      cloneUrlFor: () => "https://github.com/acme/api.git",
      exploit: async () => {
        throw new Error("lab exploded");
      },
    });

    await handler("job-1", { reviewId: review.id });
    // The scan still completes — exploitation is best-effort enrichment.
    expect((await svc.getReview(review.id))!.status).toBe("completed");
  });
});
