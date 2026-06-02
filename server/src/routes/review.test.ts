/**
 * Route tests for /v1/review/* and the GitHub webhook — Hono app.request()
 * with a passthrough auth middleware + in-memory DB.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";

import { createDb, type DB } from "../db/client.ts";
import { jobs as jobsTable, reviews as reviewsTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import type { AuthVariables } from "../auth/middleware.ts";
import { createRequireAuth } from "../auth/middleware.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { createReviewService } from "../review/service.ts";
import { FakeLlmClient } from "../review/reviewer.ts";
import { WhiteboxLaunchBodySchema } from "../review/schemas.ts";
import { createReviewRouter } from "./review.ts";
import { createReviewWebhookRouter } from "./review-webhook.ts";
import { createGithubConnectRouter } from "./github-connect.ts";
import { FakeGitHubClient } from "../review/github/client.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-review-routes-0123456789abcdef0123456789abcdef";

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
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("user_1", "user_1@x.io", clockNow);
  return db;
}

/** Passthrough auth that binds a fixed user. */
const fakeAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("user", { id: "user_1", email: "user_1@x.io" });
  c.set("session", { id: "s1", user_id: "user_1", expires_at: clockNow + 1e9 });
  await next();
};

function sqliResponder(): string {
  return JSON.stringify({
    summary: "Found a SQL injection.",
    verdicts: [
      {
        candidate_id: "diff:src/db.ts:11:0",
        file_path: "src/db.ts",
        start_line: 11,
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

const sqliPatch = [
  "@@ -10,3 +10,4 @@ function q(req) {",
  " const id = req.query.id;",
  '+const sql = "SELECT * FROM users WHERE id = " + id;',
  "+return db.exec(sql);",
  " }",
].join("\n");

function makeReviewApp(db: DB, llm = new FakeLlmClient(sqliResponder)) {
  const service = createReviewService({ db, auditKey: KEY, now: clock });
  return { app: createReviewRouter({ db, service, requireAuth: fakeAuth, llm, now: clock }), service };
}

describe("POST /v1/review (sync)", () => {
  test("runs a review on supplied files and returns the result", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        pr: 7,
        head_sha: "deadbeef",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      review_id: string;
      status: string;
      score_0_5: number;
      findings: { severity: string; cvss_score: number; side: string }[];
    };
    expect(json.score_0_5).toBe(0);
    expect(json.findings.length).toBe(1);
    expect(json.findings[0]!.severity).toBe("critical");
    expect(json.findings[0]!.cvss_score).toBe(9.8);
    // #10 — the sync 200 body MUST carry the required `status` field.
    expect(json.status).toBe("completed");
    // #13 — both serializers emit `side` (default RIGHT for added code).
    expect(json.findings[0]!.side).toBe("RIGHT");
  });

  test("#5 an oversized body is rejected with 413 before buffering/parsing", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    // ~3 MiB body — over MAX_TOTAL_REVIEW_BYTES (2 MiB) + 256 KiB headroom.
    const huge = "a".repeat(3 * 1024 * 1024);
    const body = JSON.stringify({
      repo: "acme/web",
      files: [{ path: "src/x.ts", status: "modified", patch: huge }],
    });
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body, "utf8")),
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  test("sync 200 body carries status + side; #4 oversized field is rejected 422", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    // A patch whose UTF-8 byte length exceeds MAX_PATCH_BYTES (512 KiB) via
    // 3-byte CJK chars, while its .length (UTF-16 units) is under the old cap.
    const big = "中".repeat(200_000); // 600 000 bytes, 200 000 UTF-16 units
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/x.ts", status: "modified", patch: big }],
      }),
    });
    expect(res.status).toBe(422);
  });

  test("503 when the review LLM is not configured", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const app = createReviewRouter({ db, service, requireAuth: fakeAuth, llm: null, now: clock });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "a/b", files: [{ path: "x.ts", patch: "@@ -0,0 +1 @@\n+x" }] }),
    });
    expect(res.status).toBe(503);
  });

  test("422 on a body with neither diff nor files", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "a/b" }),
    });
    expect(res.status).toBe(422);
  });

  test("cross-tenant: a slug another user connected binds to the CALLER's own repo", async () => {
    const db = freshMemDb();
    // Seed a second tenant who has already connected acme/web.
    (db.$client as Database)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("user_2", "user_2@x.io", clockNow);
    const { app, service } = makeReviewApp(db);
    const victimRepo = await service.upsertRepo({
      userId: "user_2",
      owner: "acme",
      name: "web",
    });

    // user_1 (fakeAuth) reviews the SAME slug.
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    expect(res.status).toBe(200);
    const { review_id } = (await res.json()) as { review_id: string };
    const detail = await (await app.request(`/${review_id}`)).json();

    // The review must bind to user_1's OWN repo row, never user_2's.
    expect((detail as { repo_id: string }).repo_id).not.toBe(victimRepo.id);
    // user_2's repo row is untouched.
    const victimAfter = await service.getRepo(victimRepo.id);
    expect(victimAfter!.userId).toBe("user_2");
  });
});

describe("GET /v1/review/:id + list + repos", () => {
  test("returns the review with findings, and lists reviews/repos", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const { review_id } = (await created.json()) as { review_id: string };

    const detail = await app.request(`/${review_id}`);
    expect(detail.status).toBe(200);
    const dj = (await detail.json()) as { status: string; findings: unknown[] };
    expect(dj.status).toBe("completed");
    expect(dj.findings.length).toBe(1);

    const list = await app.request("/");
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as Array<Record<string, unknown>>;
    expect(listJson.length).toBe(1);
    // #9 — list items use `review_id` + a counted `findings_count`, and MUST
    // NOT carry a `findings` array (that would crash the Reviews page).
    const item = listJson[0]!;
    expect(item.review_id).toBe(review_id);
    expect(item.findings_count).toBe(1);
    expect(item.findings).toBeUndefined();
    expect(item.repo).toBe("acme/web");

    const repos = await app.request("/repos");
    expect(repos.status).toBe(200);
    const rj = (await repos.json()) as { full_name: string }[];
    expect(rj[0]!.full_name).toBe("acme/web");
  });

  test("404 for an unknown review id", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/01JZZZUNKNOWN0000000000000");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/review/whitebox (async)", () => {
  test("enqueues a whitebox_scan job and returns 202", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api", ref: "main" }),
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { review_id: string; job_id: string; status: string };
    expect(json.status).toBe("queued");

    const jobRow = db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, json.job_id))
      .get();
    expect(jobRow!.type).toBe("whitebox_scan");
    expect(JSON.parse(jobRow!.payloadJson).reviewId).toBe(json.review_id);
  });

  test("#12 clone_url is no longer an accepted field (stripped, not consumed)", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    // A caller-supplied clone_url has no effect — the field was removed from the
    // schema (the clone URL is derived server-side from the slug). Zod strips
    // the unknown key; the request still validates + enqueues.
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/api",
        ref: "main",
        clone_url: "https://gitlab.example.com/acme/api.git",
      }),
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string; review_id: string };
    expect(json.status).toBe("queued");
    // The parsed schema type has no clone_url key (compile-time guarantee).
    const parsed = WhiteboxLaunchBodySchema.parse({
      repo: "acme/api",
      clone_url: "https://x/y.git",
    });
    expect("clone_url" in parsed).toBe(false);
  });

  test("F1: default launch persists mode='fast'", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api" }),
    });
    expect(res.status).toBe(202);
    const { review_id } = (await res.json()) as { review_id: string };
    const row = db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review_id))
      .get();
    expect(row!.mode).toBe("fast");
  });

  test("F1: mode='deep' is rejected (422) when research is disabled", async () => {
    const orig = process.env.TENSOL_RESEARCH_ENABLED;
    delete process.env.TENSOL_RESEARCH_ENABLED;
    try {
      const db = freshMemDb();
      const { app } = makeReviewApp(db);
      const res = await app.request("/whitebox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/api", mode: "deep" }),
      });
      expect(res.status).toBe(422);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("feature_disabled");
    } finally {
      if (orig !== undefined) process.env.TENSOL_RESEARCH_ENABLED = orig;
      else delete process.env.TENSOL_RESEARCH_ENABLED;
    }
  });

  test("F1: mode='deep' is honored + persisted when research is enabled", async () => {
    const orig = process.env.TENSOL_RESEARCH_ENABLED;
    process.env.TENSOL_RESEARCH_ENABLED = "true";
    try {
      const db = freshMemDb();
      const { app } = makeReviewApp(db);
      const res = await app.request("/whitebox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/api", mode: "deep" }),
      });
      expect(res.status).toBe(202);
      const { review_id } = (await res.json()) as { review_id: string };
      const row = db
        .select()
        .from(reviewsTable)
        .where(eq(reviewsTable.id, review_id))
        .get();
      expect(row!.mode).toBe("deep");
    } finally {
      if (orig !== undefined) process.env.TENSOL_RESEARCH_ENABLED = orig;
      else delete process.env.TENSOL_RESEARCH_ENABLED;
    }
  });
});

describe("POST /v1/review/github/webhook", () => {
  const SECRET = "webhook-secret-xyz";

  function sign(body: string): string {
    return `sha256=${hmacSha256(SECRET, body)}`;
  }

  function makeWebhookApp(db: DB) {
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const app = createReviewWebhookRouter({ db, service, webhookSecret: SECRET, now: clock });
    return { app, service };
  }

  const prPayload = JSON.stringify({
    action: "opened",
    installation: { id: 42 },
    repository: { full_name: "acme/web", default_branch: "main" },
    pull_request: { number: 7, head: { sha: "abc123" }, base: { sha: "def456" } },
  });

  test("401 on a bad signature", async () => {
    const db = freshMemDb();
    const { app } = makeWebhookApp(db);
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=bad" },
      body: prPayload,
    });
    expect(res.status).toBe(401);
  });

  test("202 ignored when the repo is not connected", async () => {
    const db = freshMemDb();
    const { app } = makeWebhookApp(db);
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "d-1",
        "x-hub-signature-256": sign(prPayload),
      },
      body: prPayload,
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { reason: string }).reason).toBe("repo_not_connected");
  });

  test("queues a pr_review job for a connected repo", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    // Repo is resolved by the SIGNED installation id (42 in prPayload), so it
    // must be connected WITH that installation id.
    await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "42",
    });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "d-2",
        "x-hub-signature-256": sign(prPayload),
      },
      body: prPayload,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string; review_id: string; job_id: string };
    expect(json.status).toBe("queued");

    const jobRow = db.select().from(jobsTable).where(eq(jobsTable.id, json.job_id)).get();
    expect(jobRow!.type).toBe("pr_review");
  });

  test("duplicate delivery id returns 200 duplicate", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "42",
    });
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "d-dup",
      "x-hub-signature-256": sign(prPayload),
    };
    const first = await app.request("/webhook", { method: "POST", headers, body: prPayload });
    expect(first.status).toBe(202);
    const second = await app.request("/webhook", { method: "POST", headers, body: prPayload });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");
  });

  test("#3 cross-tenant: resolves the repo by SIGNED installation id, not (owner,name)", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    // A second tenant exists who ALSO connected the same slug under a DIFFERENT
    // installation (attacker minted a row for victim/web).
    (db.$client as Database)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("attacker", "attacker@x.io", clockNow);
    await service.upsertRepo({
      userId: "attacker",
      owner: "acme",
      name: "web",
      installationId: "999", // NOT the webhook's installation id
    });
    // The victim's genuine row, bound to the webhook's installation id (42).
    const victim = await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "42",
    });

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "d-xtenant",
        "x-hub-signature-256": sign(prPayload),
      },
      body: prPayload,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { status: string; review_id: string };
    expect(json.status).toBe("queued");
    // The review must bind to the VICTIM's row (installation 42), never the
    // attacker's (installation 999).
    const review = await service.getReview(json.review_id);
    expect(review!.repoId).toBe(victim.id);
    expect(review!.userId).toBe("user_1");
  });

  test("#3 a webhook whose installation has no connected row -> 202 repo_not_connected", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    // Connected under a DIFFERENT installation id than the webhook's (42).
    await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "777",
    });
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "d-noinst",
        "x-hub-signature-256": sign(prPayload),
      },
      body: prPayload,
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { reason: string }).reason).toBe("repo_not_connected");
  });

  test("#7 dedup row + review + job commit atomically (no orphan dedup on a crash path)", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "42",
    });
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "d-atomic",
      "x-hub-signature-256": sign(prPayload),
    };
    const first = await app.request("/webhook", { method: "POST", headers, body: prPayload });
    expect(first.status).toBe(202);
    const { review_id, job_id } = (await first.json()) as {
      review_id: string;
      job_id: string;
    };
    // The dedup row, the review, AND the job all exist (committed together).
    const dedupRow = db
      .$client.query("SELECT * FROM webhook_dedup WHERE dedup_key = ?")
      .get("d-atomic");
    expect(dedupRow).not.toBeNull();
    expect((await service.getReview(review_id))!.id).toBe(review_id);
    const jobRow = db.select().from(jobsTable).where(eq(jobsTable.id, job_id)).get();
    expect(jobRow!.type).toBe("pr_review");

    // A genuine duplicate delivery rolls back and returns 200 duplicate — and
    // does NOT create a second review/job.
    const second = await app.request("/webhook", { method: "POST", headers, body: prPayload });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");
    const reviewCount = db
      .$client.query("SELECT COUNT(*) AS n FROM reviews")
      .get() as { n: number };
    expect(reviewCount.n).toBe(1);
  });

  test("@sthrip review on a repo NOT connected via its installation is ignored (no job, cross-tenant safe)", async () => {
    // The @sthrip/@tensol review comment trigger IS supported now (T040). But
    // tenant resolution is ONLY by the signed installation id: this repo was
    // upserted without an installationId, so a comment carrying installation 42
    // resolves to no connected repo → repo_not_connected, and NO review is
    // enqueued. (The positive path — connected repo → re-review — is covered in
    // review-webhook.test.ts.)
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    await service.upsertRepo({ userId: "user_1", owner: "acme", name: "web" });
    const commentPayload = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { full_name: "acme/web" },
      issue: { number: 7, pull_request: {} },
      comment: { body: "@sthrip review please", user: { login: "dev" } },
    });
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "x-github-delivery": "d-comment-1",
        "x-hub-signature-256": sign(commentPayload),
      },
      body: commentPayload,
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "repo_not_connected",
    );
    // No pr_review job enqueued for an unconnected repo.
    const jobs = db.select().from(jobsTable).where(eq(jobsTable.type, "pr_review")).all();
    expect(jobs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T012 — PATCH /repos/:id/settings
// ---------------------------------------------------------------------------
describe("PATCH /v1/review/repos/:id/settings", () => {
  async function seedRepo(service: ReturnType<typeof createReviewService>, userId: string) {
    return service.upsertRepo({ userId, owner: "acme", name: "api" });
  }

  test("updates enabled, covered_branches, status_check, merge_block and returns InstallationRepo wire shape", async () => {
    const db = freshMemDb();
    const { app, service } = makeReviewApp(db);
    const repo = await seedRepo(service, "user_1");

    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        covered_branches: ["main", "dev"],
        status_check_enabled: false,
        merge_block_on_critical: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      owner: string;
      name: string;
      enabled: boolean;
      covered_branches: string[];
      status_check_enabled: boolean;
      merge_block_on_critical: boolean;
      last_review: null;
    };
    expect(json.owner).toBe("acme");
    expect(json.name).toBe("api");
    expect(json.enabled).toBe(false);
    expect(json.covered_branches).toEqual(["main", "dev"]);
    expect(json.status_check_enabled).toBe(false);
    expect(json.merge_block_on_critical).toBe(true);
    expect(json.last_review).toBeNull();
  });

  test("non-owner (different userId) gets 403", async () => {
    const db = freshMemDb();
    // Insert a second user
    (db.$client as Database)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("user_2", "user_2@x.io", clockNow);

    const service = createReviewService({ db, auditKey: KEY, now: clock });
    // user_2 owns the repo
    const repo = await service.upsertRepo({ userId: "user_2", owner: "acme", name: "api" });

    // app uses fakeAuth → user_1
    const { app } = makeReviewApp(db);
    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("forbidden");
  });

  test("unknown repo_id gets 403 (hides existence)", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/repos/01JZZZUNKNOWN0000000000000/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    // service.updateRepoSettings returns null for missing/non-owned → 403
    expect(res.status).toBe(403);
  });

  test("covered_branches > 50 items is rejected with 400", async () => {
    const db = freshMemDb();
    const { app, service } = makeReviewApp(db);
    const repo = await seedRepo(service, "user_1");
    const tooMany = Array.from({ length: 51 }, (_, i) => `branch-${i}`);
    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ covered_branches: tooMany }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("validation_failed");
  });

  test("covered_branches item > 255 chars is rejected with 400", async () => {
    const db = freshMemDb();
    const { app, service } = makeReviewApp(db);
    const repo = await seedRepo(service, "user_1");
    const longBranch = "x".repeat(256);
    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ covered_branches: [longBranch] }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("validation_failed");
  });

  test("partial update (only enabled) leaves other settings unchanged", async () => {
    const db = freshMemDb();
    const { app, service } = makeReviewApp(db);
    const repo = await seedRepo(service, "user_1");

    // First: set covered_branches
    await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ covered_branches: ["main"] }),
    });

    // Second: only toggle enabled
    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean; covered_branches: string[] };
    expect(json.enabled).toBe(false);
    // covered_branches from the first call is preserved
    expect(json.covered_branches).toEqual(["main"]);
  });

  test("response includes repo_id field pointing to the repo", async () => {
    const db = freshMemDb();
    const { app, service } = makeReviewApp(db);
    const repo = await seedRepo(service, "user_1");

    const res = await app.request(`/repos/${repo.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { repo_id: string };
    expect(json.repo_id).toBe(repo.id);
  });
});

describe("mount isolation (webhook un-gated under the authed /v1/review prefix)", () => {
  test("webhook path reaches its handler; the authed detail path is gated", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const parent = new Hono();
    // Mirror server.ts: webhook (no session) + authed router under /v1/review.
    parent.route(
      "/v1/review/github",
      createReviewWebhookRouter({ db, service, webhookSecret: "sec", now: clock }),
    );
    parent.route(
      "/v1/review",
      createReviewRouter({
        db,
        service,
        requireAuth: createRequireAuth({ db, now: clock }),
        llm: null,
        now: clock,
      }),
    );

    // Webhook with a bad signature -> 401 invalid_signature (the WEBHOOK handler
    // ran). If requireAuth had leaked onto this path it would be "unauthenticated".
    const wh = await parent.request("/v1/review/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=bad" },
      body: "{}",
    });
    expect(wh.status).toBe(401);
    expect(((await wh.json()) as { error: string }).error).toBe("invalid_signature");

    // The authed detail path (no session cookie) is correctly gated.
    const detail = await parent.request("/v1/review/some-id");
    expect(detail.status).toBe(401);
    expect(((await detail.json()) as { error: string }).error).toBe("unauthenticated");
  });
});

// ---------------------------------------------------------------------------
// T017 — /v1/github connect router mount regression
// ---------------------------------------------------------------------------
describe("mount regression: /v1/github connect router", () => {
  test("GET /v1/github/connect is auth-gated (401 when no session)", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const parent = new Hono();
    parent.route(
      "/v1/github",
      createGithubConnectRouter({
        db,
        service,
        github: new FakeGitHubClient(),
        requireAuth: createRequireAuth({ db, now: clock }),
        slug: "sthrip-app",
        stateSecret: "state-secret-0123456789abcdef",
        now: clock,
      }),
    );

    const res = await parent.request("/v1/github/connect");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("GET /v1/github/connect with session + empty slug → 503 (graceful-null)", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const parent = new Hono();
    parent.route(
      "/v1/github",
      createGithubConnectRouter({
        db,
        service,
        github: new FakeGitHubClient(),
        requireAuth: fakeAuth,
        slug: "", // absent → /connect returns 503
        stateSecret: "state-secret-0123456789abcdef",
        now: clock,
      }),
    );

    const res = await parent.request("/v1/github/connect");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("github_app_unconfigured");
  });

  test("GET /v1/github/installations is auth-gated (401 when no session)", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const parent = new Hono();
    parent.route(
      "/v1/github",
      createGithubConnectRouter({
        db,
        service,
        github: new FakeGitHubClient(),
        requireAuth: createRequireAuth({ db, now: clock }),
        slug: "",
        stateSecret: "state-secret-0123456789abcdef",
        now: clock,
      }),
    );

    const res = await parent.request("/v1/github/installations");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });
});
