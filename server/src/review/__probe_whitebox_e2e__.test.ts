/**
 * QA PROBE — Whitebox-scan pipeline E2E (003-whitebox).
 *
 * Read-only probe of the WHITEBOX path. Exercises real modules
 * (fileToAddedDiff / splitUnifiedDiff / parseAddedHunks / deriveCandidates /
 * runReview / createWhiteboxScanHandler / service / routes) with fakes only at
 * the LLM + repo-fetch boundaries. Does NOT modify any source/test file.
 *
 * Run:
 *   cd server && bun test src/review/__probe_whitebox_e2e__.test.ts
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { type MiddlewareHandler } from "hono";

import { createDb, type DB } from "../db/client.ts";
import { jobs as jobsTable, auditLog as auditLogTable } from "../db/schema.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createReviewService } from "./service.ts";
import { FakeLlmClient, type LlmClient } from "./reviewer.ts";
import {
  fileToAddedDiff,
  fileToDiffFile,
  type RepoCheckout,
  type RepoFetcher,
  type RepoFetchArgs,
} from "./repo-fetch.ts";
import { splitUnifiedDiff, parseAddedHunks, deriveCandidates } from "./candidates.ts";
import { createReviewRouter } from "../routes/review.ts";
import { createWhiteboxScanHandler } from "../jobs/handlers/whitebox-scan.ts";
import { createPrReviewHandler } from "../jobs/handlers/pr-review.ts";
import { FakeGitHubClient } from "./github/client.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "probe-whitebox-e2e-key-0123456789abcdef0123456789abcdef";

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

function seedUser(db: DB, id: string): void {
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run(id, `${id}@x.io`, clockNow);
}

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  seedUser(db, "user_1");
  seedUser(db, "u");
  return db;
}

function makeSvc(db: DB) {
  return createReviewService({ db, auditKey: KEY, now: clock });
}

/** Passthrough auth binding a fixed user (mirrors review.test.ts). */
const fakeAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("user", { id: "user_1", email: "user_1@x.io" });
  c.set("session", { id: "s1", user_id: "user_1", expires_at: clockNow + 1e9 });
  await next();
};

function eventsFor(db: DB): string[] {
  return db
    .select({ event: auditLogTable.event })
    .from(auditLogTable)
    .orderBy(sql`${auditLogTable.id} ASC`)
    .all()
    .map((r) => r.event);
}

// ===========================================================================
// PROBE 1 — fileToAddedDiff + downstream consumption
// ===========================================================================
describe("PROBE 1: fileToAddedDiff -> splitUnifiedDiff/parseAddedHunks", () => {
  test("vulnerable TS file: well-formed single-hunk added patch, whole-file candidate", () => {
    const src = [
      "import { db } from './db';",
      "export function q(req) {",
      "  const id = req.query.id;",
      '  const sql = "SELECT * FROM users WHERE id = " + id;',
      "  return db.exec(sql);",
      "}",
    ].join("\n") + "\n";

    const patch = fileToAddedDiff(src);
    // header line count must match visible lines (6, trailing newline dropped).
    expect(patch.startsWith("@@ -0,0 +1,6 @@\n")).toBe(true);
    // every body line is a "+"-prefixed added line.
    const body = patch.split("\n").slice(1);
    expect(body.length).toBe(6);
    expect(body.every((l) => l.startsWith("+"))).toBe(true);

    // parseAddedHunks consumes it: one contiguous added run, newStart=1.
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.newStart).toBe(1);
    expect(hunks[0]!.endLine).toBe(6);
    expect(hunks[0]!.snippet).toContain('SELECT * FROM users WHERE id = " + id');

    // deriveCandidates yields one whole-file candidate covering the file.
    const cands = deriveCandidates({ files: [fileToDiffFile("src/db.ts", src)] });
    expect(cands.length).toBe(1);
    expect(cands[0]!.filePath).toBe("src/db.ts");
    expect(cands[0]!.startLine).toBe(1);
  });

  test("empty file -> empty patch -> NO candidate (consistent w/ design)", () => {
    expect(fileToAddedDiff("")).toBe("");
    const cands = deriveCandidates({ files: [fileToDiffFile("empty.ts", "")] });
    // empty patch => parseAddedHunks([]) => no candidate. Empty file is a no-op.
    expect(cands.length).toBe(0);
  });

  test("file with NO trailing newline: all lines added, count correct", () => {
    const src = "const a = 1;\nconst b = 2;\nconst c = 3;"; // no final \n
    const patch = fileToAddedDiff(src);
    expect(patch.startsWith("@@ -0,0 +1,3 @@\n")).toBe(true);
    const hunks = parseAddedHunks(patch);
    expect(hunks[0]!.endLine).toBe(3);
    expect(hunks[0]!.snippet).toBe("const a = 1;\nconst b = 2;\nconst c = 3;");
  });

  test("1-line file", () => {
    expect(fileToAddedDiff("only one line")).toBe("@@ -0,0 +1,1 @@\n+only one line");
    const hunks = parseAddedHunks("@@ -0,0 +1,1 @@\n+only one line");
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.snippet).toBe("only one line");
  });

  test("path with spaces + unicode survives splitUnifiedDiff round-trip via DiffFile", () => {
    const path = "src/файл with space.ts";
    const df = fileToDiffFile(path, "export const x = 1\n");
    expect(df.path).toBe(path);
    const cands = deriveCandidates({ files: [df] });
    expect(cands.length).toBe(1);
    expect(cands[0]!.filePath).toBe(path);
  });

  test("EDGE: CRLF line endings keep the \\r in every added line + count", () => {
    // Windows checkouts: git core.autocrlf can leave CRLF. content.split("\n")
    // leaves a trailing "\r" on each line; the synthesized patch carries it.
    const src = "line1\r\nline2\r\nline3\r\n";
    const patch = fileToAddedDiff(src);
    // After trailing-"" pop, 3 lines remain, each ending in \r.
    expect(patch).toBe("@@ -0,0 +1,3 @@\n+line1\r\n+line2\r\n+line3\r");
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.endLine).toBe(3);
    // The \r rides along into the snippet (cosmetic; documents behavior).
    expect(hunks[0]!.snippet).toBe("line1\r\nline2\r\nline3\r");
  });

  test("EDGE: blank-line-only file (\"\\n\\n\") -> NOT empty patch, count=2 blank added lines", () => {
    // Distinct from the truly empty file: two newlines = two blank lines.
    const patch = fileToAddedDiff("\n\n");
    // split("\n") -> ["","",""]; pop trailing "" -> ["",""]; n=2.
    expect(patch).toBe("@@ -0,0 +1,2 @@\n+\n+");
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.endLine).toBe(2);
  });

  test("EDGE: file whose content embeds a fake diff header is NOT mis-split as a new hunk", () => {
    // A source file that literally contains "@@ ... @@" or "diff --git" lines.
    // Because fileToAddedDiff prefixes EVERY line with "+", the embedded header
    // becomes "+@@ ..." which HUNK_HEADER (anchored ^@@) does not match.
    const src = [
      "// docs example:",
      "@@ -1,2 +3,4 @@ not a real header",
      "diff --git a/x b/x",
      "const safe = true;",
    ].join("\n") + "\n";
    const patch = fileToAddedDiff(src);
    const hunks = parseAddedHunks(patch);
    // Must remain ONE hunk of 4 added lines, not fragmented by the fake header.
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.newStart).toBe(1);
    expect(hunks[0]!.endLine).toBe(4);
  });

  test("EDGE: large file (1200 lines) -> single hunk, +1200 count, deriveCandidates=1", () => {
    const src = Array.from({ length: 1200 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
    const patch = fileToAddedDiff(src);
    expect(patch.startsWith("@@ -0,0 +1,1200 @@\n")).toBe(true);
    const hunks = parseAddedHunks(patch);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.endLine).toBe(1200);
    const cands = deriveCandidates({ files: [fileToDiffFile("big.ts", src)] });
    // Whole-file = ONE hunk, so the per-file cap (8) is irrelevant here: 1 cand.
    expect(cands.length).toBe(1);
  });
});

// ===========================================================================
// PROBE 2 — POST /whitebox launch endpoint
// ===========================================================================
describe("PROBE 2: POST /v1/review/whitebox launch", () => {
  function makeApp(db: DB, llm: LlmClient | null = new FakeLlmClient(() => "{}")) {
    const service = makeSvc(db);
    return {
      app: createReviewRouter({ db, service, requireAuth: fakeAuth, llm, now: clock }),
      service,
    };
  }

  test("{repo} variant -> 202, whitebox review queued + whitebox_scan job w/ right payload", async () => {
    const db = freshMemDb();
    const { app, service } = makeApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api", ref: "main" }),
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { review_id: string; job_id: string; status: string };
    expect(json.status).toBe("queued");

    const review = await service.getReview(json.review_id);
    expect(review!.kind).toBe("whitebox");
    expect(review!.status).toBe("queued");
    expect(review!.commitRef).toBe("main");

    const jobRow = db.select().from(jobsTable).where(eq(jobsTable.id, json.job_id)).get();
    expect(jobRow!.type).toBe("whitebox_scan");
    const payload = JSON.parse(jobRow!.payloadJson) as { type: string; reviewId: string };
    expect(payload.type).toBe("whitebox_scan");
    expect(payload.reviewId).toBe(json.review_id);
  });

  test("{repo_id} variant (existing connected repo) -> 202 reusing that repo", async () => {
    const db = freshMemDb();
    const { app, service } = makeApp(db);
    const repo = await service.upsertRepo({ userId: "user_1", owner: "acme", name: "api" });
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: repo.id }),
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { review_id: string };
    const review = await service.getReview(json.review_id);
    expect(review!.repoId).toBe(repo.id);
  });

  test("missing repo AND repo_id -> clean 4xx (NOT 500)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "main" }), // neither repo nor repo_id
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBe(422);
  });

  test("foreign repo_id (another tenant) -> 404 (hides existence), no job enqueued", async () => {
    const db = freshMemDb();
    seedUser(db, "user_2");
    const { app, service } = makeApp(db);
    const foreign = await service.upsertRepo({ userId: "user_2", owner: "acme", name: "secret" });
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_id: foreign.id }),
    });
    expect(res.status).toBe(404);
    const jobs = db.select().from(jobsTable).where(eq(jobsTable.type, "whitebox_scan")).all();
    expect(jobs.length).toBe(0);
  });

  test("invalid JSON body -> 400 (NOT 500)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("malformed repo slug -> 422 validation_failed (NOT 500)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "no-slash-here" }),
    });
    expect(res.status).toBe(422);
  });
});

// ===========================================================================
// PROBE 3 — Whitebox handler E2E (checkout -> engine -> findings; cleanup)
// ===========================================================================

/**
 * A RepoFetcher that records fetch + cleanup calls and lets the test choose
 * whether a `repoDir` is present (on-disk vs in-mem). Cleanup tracking is the
 * point: it is NOT observable through the shipped `FakeRepoFetcher`.
 */
class TrackingRepoFetcher implements RepoFetcher {
  readonly fetchCalls: RepoFetchArgs[] = [];
  cleanupCount = 0;
  readonly #files: Record<string, string>;
  readonly #withRepoDir: boolean;

  constructor(files: Record<string, string>, opts?: { repoDir?: boolean }) {
    this.#files = { ...files };
    this.#withRepoDir = opts?.repoDir ?? false;
  }

  fetch(args: RepoFetchArgs): Promise<RepoCheckout> {
    this.fetchCalls.push(args);
    const files = Object.entries(this.#files).map(([p, c]) => fileToDiffFile(p, c));
    const checkout: RepoCheckout = {
      files,
      ...(this.#withRepoDir ? { repoDir: "/tmp/fake-checkout-does-not-exist" } : {}),
      cleanup: () => {
        this.cleanupCount += 1;
      },
    };
    return Promise.resolve(checkout);
  }
}

function multiFileVulnResponder(): string {
  // Verdicts for the multi-file repo: one SQLi (critical) + one non-vuln.
  return JSON.stringify({
    summary: "Whitebox scan results.",
    verdicts: [
      {
        candidate_id: "diff:src/db.ts:1:0",
        file_path: "src/db.ts",
        start_line: 4,
        is_vulnerability: true,
        category: "SQL Injection",
        cwe: ["CWE-89"],
        rationale_md: "req.query.id concatenated into SQL string, reachable.",
        reachable: true,
        confidence: "high",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "H" },
        title: "SQL injection in db.ts",
      },
      {
        candidate_id: "diff:src/util.ts:1:0",
        file_path: "src/util.ts",
        is_vulnerability: false, // must be filtered out
        category: "None",
        cwe: [],
        rationale_md: "pure helper, no sink.",
        reachable: false,
        confidence: "low",
        cvss: { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "N", I: "N", A: "N" },
        title: "no issue",
      },
    ],
  });
}

describe("PROBE 3: whitebox handler E2E", () => {
  const repoFiles = {
    "src/db.ts": [
      "import { db } from './conn';",
      "export function q(req) {",
      "  const id = req.query.id;",
      '  return db.exec("SELECT * FROM users WHERE id = " + id);',
      "}",
    ].join("\n") + "\n",
    "src/util.ts": "export const add = (a, b) => a + b;\n",
    "README.md": "# docs\n", // not a DiffFile in this fake; included only to assert it does not appear
  };

  test("happy path: checkout -> diffs -> engine -> findings persisted, status queued->running->completed, audit events, CLEANUP called", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });
    expect(review.status).toBe("queued");

    // Only feed the two source files (README is not a code DiffFile here).
    const fetcher = new TrackingRepoFetcher({
      "src/db.ts": repoFiles["src/db.ts"],
      "src/util.ts": repoFiles["src/util.ts"],
    });
    const cloneUrls: Array<{ owner: string; name: string }> = [];
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(multiFileVulnResponder),
      cloneUrlFor: (r) => {
        cloneUrls.push({ owner: r.owner, name: r.name });
        return `https://github.com/${r.owner}/${r.name}.git`;
      },
    });

    await handler("job-wb-1", { reviewId: review.id });

    // repo checked out exactly once with the right clone URL.
    expect(fetcher.fetchCalls.length).toBe(1);
    expect(fetcher.fetchCalls[0]!.cloneUrl).toBe("https://github.com/acme/api.git");
    expect(cloneUrls).toEqual([{ owner: "acme", name: "api" }]);

    // findings persisted (1 vuln; the is_vulnerability:false verdict is filtered).
    const finalized = await svc.getReview(review.id);
    expect(finalized!.status).toBe("completed");
    expect(finalized!.score0to5).toBe(0); // critical SQLi gates to 0
    expect(finalized!.findingsCount).toBe(1);
    const findings = await svc.getReviewFindings(review.id);
    expect(findings.length).toBe(1);
    expect(findings[0]!.category).toBe("SQL Injection");
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.reviewId).toBe(review.id);

    // audit events: started + completed, both whitebox-flavored.
    const events = eventsFor(db);
    expect(events).toContain("whitebox_scan_started");
    expect(events).toContain("whitebox_scan_completed");
    // It must NOT emit the pr-flavored names.
    expect(events).not.toContain("review_started");
    expect(events).not.toContain("review_completed");

    // CLEANUP called exactly once on the happy path (no temp-dir leak).
    expect(fetcher.cleanupCount).toBe(1);
  });

  test("on-disk checkout (repoDir set): cleanup still called once on success", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });
    const fetcher = new TrackingRepoFetcher(
      { "src/util.ts": "export const x = 1;\n" },
      { repoDir: true },
    );
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      // No SAST runner wired -> repoDir present but no SAST attempted; LLM judges
      // the lone benign whole-file candidate as non-vuln (empty verdicts).
      llm: new FakeLlmClient(() => JSON.stringify({ summary: "clean", verdicts: [] })),
      cloneUrlFor: (r) => `https://github.com/${r.owner}/${r.name}.git`,
    });
    await handler("job-wb-2", { reviewId: review.id });
    const finalized = await svc.getReview(review.id);
    expect(finalized!.status).toBe("completed");
    expect(finalized!.score0to5).toBe(5); // no findings -> clean
    expect(fetcher.cleanupCount).toBe(1);
  });

  test("LLM throws AFTER checkout: review -> failed AND checkout cleaned up (no leak)", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    const fetcher = new TrackingRepoFetcher({ "src/db.ts": repoFiles["src/db.ts"] });
    const throwingLlm: LlmClient = {
      complete: async () => {
        throw new Error("LLM upstream 503 (transient)");
      },
    };
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: throwingLlm,
      cloneUrlFor: (r) => `https://github.com/${r.owner}/${r.name}.git`,
    });

    await expect(handler("job-wb-3", { reviewId: review.id })).rejects.toThrow(/503/);

    const after = await svc.getReview(review.id);
    expect(after!.status).toBe("failed");
    expect(after!.error).toContain("503");
    // The checkout WAS fetched, so cleanup MUST run despite the engine throwing.
    expect(fetcher.fetchCalls.length).toBe(1);
    expect(fetcher.cleanupCount).toBe(1); // <-- no temp-dir leak on error

    // review_failed audit event emitted.
    expect(eventsFor(db)).toContain("review_failed");
  });

  test("missing reviewId payload -> throws (does NOT touch the fetcher)", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const fetcher = new TrackingRepoFetcher({});
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(() => "{}"),
      cloneUrlFor: () => "https://x/y.git",
    });
    await expect(handler("job-wb-4", { nope: true })).rejects.toThrow(/missing reviewId/);
    expect(fetcher.fetchCalls.length).toBe(0);
    expect(fetcher.cleanupCount).toBe(0);
  });

  test("cloneUrlFor throws BEFORE fetch -> failed, fetcher never called, no cleanup leak", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });
    const fetcher = new TrackingRepoFetcher({ "src/db.ts": "x\n" });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(() => "{}"),
      cloneUrlFor: () => {
        throw new Error("no installation token");
      },
    });
    await expect(handler("job-wb-5", { reviewId: review.id })).rejects.toThrow(/no installation/);
    expect((await svc.getReview(review.id))!.status).toBe("failed");
    // fetch never happened, so nothing to clean up (no spurious cleanup, no leak).
    expect(fetcher.fetchCalls.length).toBe(0);
    expect(fetcher.cleanupCount).toBe(0);
  });

  test("completed review short-circuits: handler does not re-fetch", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });
    const fetcher = new TrackingRepoFetcher({ "src/util.ts": "export const x=1;\n" });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(() => JSON.stringify({ summary: "clean", verdicts: [] })),
      cloneUrlFor: (r) => `https://github.com/${r.owner}/${r.name}.git`,
    });
    await handler("job-wb-6", { reviewId: review.id });
    expect(fetcher.fetchCalls.length).toBe(1);
    // Re-dispatch the same (now completed) review.
    await handler("job-wb-6-again", { reviewId: review.id });
    expect(fetcher.fetchCalls.length).toBe(1); // no second fetch
  });

  test("repo missing for the review -> failed + rethrow, fetcher untouched", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    // Review with no repoId at all.
    const review = await svc.createReview({ repoId: null, userId: "u", kind: "whitebox" });
    const fetcher = new TrackingRepoFetcher({ "x.ts": "y\n" });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(() => "{}"),
      cloneUrlFor: () => "https://x/y.git",
    });
    await expect(handler("job-wb-7", { reviewId: review.id })).rejects.toThrow(/repo not found/);
    expect((await svc.getReview(review.id))!.status).toBe("failed");
    expect(fetcher.fetchCalls.length).toBe(0);
  });
});

// ===========================================================================
// PROBE 4 — Cross-check kind routing (whitebox vs pr handlers)
// ===========================================================================
describe("PROBE 4: kind routing cross-check", () => {
  test("pr_review handler over a WHITEBOX review fails fast (missing prNumber/headSha), no GitHub posting", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    // A whitebox review has no prNumber/headSha.
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    const github = new FakeGitHubClient({ files: [] });
    const prHandler = createPrReviewHandler({
      service: svc,
      github,
      llm: new FakeLlmClient(() => "{}"),
    });

    // The pr_review handler guards on prNumber/headSha and throws before any
    // engine/posting work — a misrouted whitebox review cannot be PR-processed.
    await expect(prHandler("job-x", { reviewId: review.id })).rejects.toThrow(
      /missing prNumber\/headSha/,
    );
    expect((await svc.getReview(review.id))!.status).toBe("failed");
    // No GitHub side effects from a misrouted review.
    expect(github.getFilesCalls.length).toBe(0);
    expect(github.postReviewCalls.length).toBe(0);
    expect(github.createCheckRunCalls.length).toBe(0);
  });

  test("whitebox handler over a PR review still runs (handler is kind-agnostic) — documents that routing is enforced by the runner/enqueue side, NOT the handler", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    // A PR review row (kind=pr) but routed to the WHITEBOX handler.
    const review = await svc.createReview({
      repoId: repo.id,
      userId: "u",
      kind: "pr",
      prNumber: 9,
      headSha: "abc",
    });
    const fetcher = new TrackingRepoFetcher({ "src/util.ts": "export const x=1;\n" });
    const wbHandler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: new FakeLlmClient(() => JSON.stringify({ summary: "clean", verdicts: [] })),
      cloneUrlFor: (r) => `https://github.com/${r.owner}/${r.name}.git`,
    });

    // The whitebox handler does NOT inspect review.kind — it will clone + scan
    // even a `pr` row. Routing correctness therefore depends entirely on the
    // enqueue side picking the right job type. This documents the contract.
    await wbHandler("job-y", { reviewId: review.id });
    const after = await svc.getReview(review.id);
    expect(after!.status).toBe("completed");
    expect(after!.kind).toBe("pr"); // kind unchanged

    // Because the row is kind=pr, the service emits PR-flavored audit events
    // even though the WHITEBOX handler ran it (the service keys events off the
    // row's kind, not the handler). This is the observable routing fingerprint.
    const events = eventsFor(db);
    expect(events).toContain("review_started");
    expect(events).toContain("review_completed");
    expect(events).not.toContain("whitebox_scan_started");
  });

  test("whitebox launch enqueues whitebox_scan (not pr_review); webhook-side enqueues pr_review (not whitebox)", async () => {
    // End-to-end routing fingerprint at the enqueue boundary (where it is
    // actually enforced). The /whitebox route enqueues ONLY whitebox_scan.
    const db = freshMemDb();
    const service = makeSvc(db);
    const app = createReviewRouter({
      db,
      service,
      requireAuth: fakeAuth,
      llm: new FakeLlmClient(() => "{}"),
      now: clock,
    });
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api" }),
    });
    expect(res.status).toBe(202);
    const wbJobs = db.select().from(jobsTable).where(eq(jobsTable.type, "whitebox_scan")).all();
    const prJobs = db.select().from(jobsTable).where(eq(jobsTable.type, "pr_review")).all();
    expect(wbJobs.length).toBe(1);
    expect(prJobs.length).toBe(0);
  });
});

// ===========================================================================
// PROBE 5 — CONFIRMED BUG: source lines starting with "++" vanish from the
// whole-file candidate snippet (and fragment the file into multiple candidates).
//
// ROOT CAUSE: fileToAddedDiff (repo-fetch.ts:30) prefixes EVERY source line with
// a single "+". A source line that already begins with "++" thus becomes a line
// beginning with "+++". parseAddedHunks (candidates.ts:57) keeps added lines via
//   line.startsWith("+") && !line.startsWith("+++")
// — the "+++" guard exists to skip a unified-diff "+++ b/file" HEADER. For
// SYNTHESIZED whole-file patches that header never exists, so the guard instead
// misclassifies any real source line that began with "++" as a header and DROPS
// it, ending the current added-run. The file's whole-file candidate splits into
// two candidates with the "++"-line's content silently GONE from both snippets.
// ===========================================================================
describe("PROBE 5: '++'-prefixed source lines dropped from whitebox candidates (CONFIRMED BUG)", () => {
  test("a line beginning with '++' is lost from the candidate snippet + splits the file", () => {
    // Realistic: a unary pre-increment statement on its own line.
    const src = ["let i = 0;", "++i;", "doWork(i);"].join("\n") + "\n";
    const cands = deriveCandidates({ files: [fileToDiffFile("src/loop.ts", src)] });

    // BUG: the whole-file candidate fragments into TWO candidates instead of one,
    // and the "++i;" line is absent from every candidate snippet.
    expect(cands.length).toBe(2); // expected 1 whole-file candidate
    const allSnippets = cands.map((c) => c.snippet ?? "").join("\n");
    expect(allSnippets).not.toContain("++i;"); // <-- DATA LOSS
    expect(allSnippets).toBe("let i = 0;\ndoWork(i);");
    // The second fragment also reports a WRONG startLine (3, skipping line 2).
    expect(cands[1]!.startLine).toBe(3);
  });

  test("end-to-end: whitebox candidate snippet shown to the LLM omits the '++'-prefixed sink", async () => {
    const db = freshMemDb();
    const svc = makeSvc(db);
    const repo = await svc.upsertRepo({ userId: "u", owner: "acme", name: "api" });
    const review = await svc.createReview({ repoId: repo.id, userId: "u", kind: "whitebox" });

    // The vulnerable sink line begins with "++" (e.g. a C-ish/JS pointer/index
    // bump preceding an unsafe call). The file is small so the FULL patch is also
    // dumped into the context bundle — but the focused CANDIDATE snippet (the
    // block the model is asked to judge one-by-one) loses the sink line.
    const vulnFile =
      [
        "function handler(req) {",
        "  let idx = 0;",
        "++idx; eval(req.query.cmd);", // sink line starts with "++" -> dropped from candidate
        "  return idx;",
        "}",
      ].join("\n") + "\n";

    const sentUserPrompts: string[] = [];
    const recordingLlm: LlmClient = {
      complete: async ({ user }) => {
        sentUserPrompts.push(user);
        return JSON.stringify({ summary: "clean", verdicts: [] });
      },
    };

    const fetcher = new TrackingRepoFetcher({ "src/handler.ts": vulnFile });
    const handler = createWhiteboxScanHandler({
      service: svc,
      fetcher,
      llm: recordingLlm,
      cloneUrlFor: (r) => `https://github.com/${r.owner}/${r.name}.git`,
    });

    await handler("job-bug-1", { reviewId: review.id });
    expect((await svc.getReview(review.id))!.status).toBe("completed");

    const prompt = sentUserPrompts[0] ?? "";
    // The "## Candidates to evaluate" block exists; locate the candidate snippet
    // region (after that header).
    const candIdx = prompt.indexOf("## Candidates to evaluate");
    expect(candIdx).toBeGreaterThan(-1);
    const candidateRegion = prompt.slice(candIdx);

    // BUG IMPACT: the eval() sink that rides on the "++idx;" line is ABSENT from
    // the focused candidate snippet region the model evaluates per-candidate.
    // (It survives only in the raw "## Code context" patch dump above, where the
    // model is NOT asked the focused exploitability question about it.)
    expect(candidateRegion).not.toContain("++idx; eval(req.query.cmd);");

    // And the file fragmented into TWO candidate blocks rather than one.
    const candidateIdCount = (candidateRegion.match(/candidate_id: diff:src\/handler\.ts:/g) ?? [])
      .length;
    expect(candidateIdCount).toBe(2); // expected 1 whole-file candidate
  });

  test("CONTRAST: the same file with the sink NOT '++'-prefixed yields ONE intact candidate", () => {
    // Control: identical structure, sink line does not start with "++".
    const ok = ["function handler(req) {", "  eval(req.query.cmd);", "}"].join("\n") + "\n";
    const cands = deriveCandidates({ files: [fileToDiffFile("src/handler.ts", ok)] });
    expect(cands.length).toBe(1);
    expect(cands[0]!.snippet).toContain("eval(req.query.cmd);");
  });
});
