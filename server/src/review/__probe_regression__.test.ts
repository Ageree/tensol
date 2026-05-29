/**
 * REGRESSION PROBE — does the uncommitted ~518-line simplification of the
 * review domain silently roll back the 13 hardening fixes from commit 20a454d?
 *
 * This file is a *read-only* auditor's probe: it touches NO production source
 * and NO existing test. Each block re-creates the in-mem DB + migrations +
 * passthrough-auth harness used by `routes/review.test.ts` and asserts the
 * CURRENT working-tree behavior, labelling each probe REGRESSION (proves the
 * 20a454d fix was reverted) or RETAINED (the fix survived).
 *
 * Run: cd server && bun test src/review/__probe_regression__.test.ts
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type MiddlewareHandler } from "hono";

import { createDb, type DB } from "../db/client.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { hmacSha256 } from "../lib/crypto.ts";
import { createReviewService } from "../review/service.ts";
import { FakeLlmClient } from "../review/reviewer.ts";
import { createReviewRouter } from "../routes/review.ts";
import { createReviewWebhookRouter } from "../routes/review-webhook.ts";
import { parseAddedHunks } from "../review/candidates.ts";
import { normalizeSarif } from "../review/sarif.ts";
import { createOpenRouterClient } from "../review/llm/openrouter.ts";
import { createPrReviewHandler } from "../jobs/handlers/pr-review.ts";
import { FakeGitHubClient } from "../review/github/client.ts";

// --------------------------------------------------------------------------
// Harness (mirrors routes/review.test.ts).
// --------------------------------------------------------------------------
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

let clockNow = 1_900_000_000_000;
const clock = () => clockNow++;

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("user_1", "user_1@x.io", clockNow);
  return db;
}

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
  return {
    app: createReviewRouter({ db, service, requireAuth: fakeAuth, llm, now: clock }),
    service,
  };
}

const WEBHOOK_SECRET = "webhook-secret-xyz";
function sign(body: string): string {
  return `sha256=${hmacSha256(WEBHOOK_SECRET, body)}`;
}
function makeWebhookApp(db: DB) {
  const service = createReviewService({ db, auditKey: KEY, now: clock });
  const app = createReviewWebhookRouter({
    db,
    service,
    webhookSecret: WEBHOOK_SECRET,
    now: clock,
  });
  return { app, service };
}

// ==========================================================================
// CRIT-1 — GET /v1/review list wire shape ({review_id}+{findings_count}+findings)
// 20a454d: client renders r.review_id + r.findings.length; the list MUST emit
// review_id (NOT id). Working tree reverted to {id,...}.
// ==========================================================================
describe("CRIT-1 GET /v1/review list wire shape", () => {
  test("PROBE: list item must carry review_id (client reads r.review_id)", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const list = (await (await app.request("/")).json()) as Array<Record<string, unknown>>;
    const item = list[0]!;
    // Reviews.tsx: key={r.review_id}, to={`/reviews/${r.review_id}`}, {r.findings.length}
    console.log("CRIT-1 list[0] keys:", Object.keys(item).sort().join(","));
    console.log("CRIT-1 review_id:", item.review_id, " id:", item.id, " findings:", item.findings);
    // Hardened expectation (would PASS on 20a454d): a review_id field exists.
    expect(item.review_id, "list item MUST expose review_id for the client").toBeDefined();
  });
});

// ==========================================================================
// HIGH-2 — Cross-tenant PR-review takeover via webhook
// 20a454d: resolve by SIGNED installation_id (getRepoByInstallation), not slug.
// Working tree reverted to getRepoByFullName(owner,name) -> any tenant's slug.
// ==========================================================================
describe("HIGH-2 cross-tenant webhook repo resolution", () => {
  test("PROBE: webhook for installation 42 must NOT bind to user_2's slug row connected under installation 99", async () => {
    const db = freshMemDb();
    (db.$client as Database)
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run("user_2", "user_2@x.io", clockNow);
    const { app, service } = makeWebhookApp(db);
    // VICTIM user_2 connected acme/web under THEIR installation 99.
    await service.upsertRepo({
      userId: "user_2",
      owner: "acme",
      name: "web",
      installationId: "99",
    });
    // user_1 has NOT connected acme/web at all.

    // Attacker/foreign webhook carries installation 42 (NOT user_2's 99).
    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "acme/web", default_branch: "main" },
      pull_request: { number: 7, head: { sha: "abc123" }, base: { sha: "def456" } },
    });
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "xtenant-1",
        "x-hub-signature-256": sign(payload),
      },
      body: payload,
    });
    const body = (await res.json()) as { status: string; reason?: string };
    console.log("HIGH-2 status:", res.status, "body:", JSON.stringify(body));
    // Hardened (20a454d): installation 42 has NO connected row -> 202 repo_not_connected.
    // Reverted: getRepoByFullName matches user_2's acme/web by slug -> 202 "queued"
    // (a review/job created against user_2's repo by a foreign installation = takeover).
    expect(
      body.status === "ignored" && body.reason === "repo_not_connected",
      "a webhook for an unconnected installation must be repo_not_connected, never queued against another tenant's slug",
    ).toBe(true);
  });
});

// ==========================================================================
// HIGH-3 — Webhook dedup atomicity (dedup row in SAME tx as review+job)
// 20a454d: dedup row inserted inside withTx with review+job; a crash before
// COMMIT rolls back the dedup row so GitHub's retry re-processes.
// Working tree: dedup row committed FIRST in a separate db.insert (step 3),
// BEFORE the review+job -> a crash strands the delivery forever.
// ==========================================================================
describe("HIGH-3 webhook dedup atomicity", () => {
  test("PROBE: a crash after dedup-row commit but before review+job must NOT strand the delivery", async () => {
    const db = freshMemDb();
    const { app, service } = makeWebhookApp(db);
    await service.upsertRepo({ userId: "user_1", owner: "acme", name: "web" });

    // Wrap the service so the review+job insert (createQueuedReviewWithJob)
    // THROWS — simulating a crash AFTER the dedup row was already committed.
    const crashingService = {
      ...service,
      createQueuedReviewWithJob: async () => {
        throw new Error("simulated crash after dedup commit, before review+job");
      },
    };
    const crashApp = createReviewWebhookRouter({
      db,
      service: crashingService,
      webhookSecret: WEBHOOK_SECRET,
      now: clock,
    });

    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 42 },
      repository: { full_name: "acme/web", default_branch: "main" },
      pull_request: { number: 7, head: { sha: "abc123" }, base: { sha: "def456" } },
    });
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "atomic-1",
      "x-hub-signature-256": sign(payload),
    };

    // Delivery #1 crashes mid-handling (GitHub will retry the same delivery id).
    let firstThrew = false;
    try {
      const r1 = await crashApp.request("/webhook", { method: "POST", headers, body: payload });
      console.log("HIGH-3 delivery#1 status:", r1.status);
    } catch {
      firstThrew = true;
    }
    const dedupRows = (db.$client as Database)
      .query("SELECT dedup_key FROM webhook_dedup WHERE dedup_key = ?")
      .all("atomic-1") as Array<{ dedup_key: string }>;
    console.log("HIGH-3 delivery#1 threw:", firstThrew, "dedup rows persisted:", dedupRows.length);

    // GitHub RETRIES the same delivery id. With a HEALTHY service this time.
    const retry = await app.request("/webhook", { method: "POST", headers, body: payload });
    const retryBody = (await retry.json()) as { status: string };
    console.log("HIGH-3 retry status:", retry.status, "body:", JSON.stringify(retryBody));

    // Hardened (20a454d): dedup row rolled back on crash -> retry re-processes -> "queued".
    // Reverted: dedup row committed before the crash -> retry sees a duplicate ->
    // 200 "duplicate" and the PR is NEVER reviewed (stranded delivery).
    expect(
      retryBody.status,
      "after a crash before review+job, the GitHub retry must re-process (queued), not be swallowed as duplicate",
    ).toBe("queued");
  });
});

// ==========================================================================
// HIGH-4 — pr_review retry idempotency vs GitHub state
// 20a454d: scan existing PR comment bodies for tensol:fp via listReviewComments
// and merge into the skip set, so a retry after a successful post (but before
// the thread row committed) does NOT double-post.
// Working tree: listReviewComments + fingerprintsFromComments removed; dedup is
// SOLELY the local thread row -> retry double-posts.
// ==========================================================================
describe("HIGH-4 pr_review retry double-post", () => {
  test("PROBE: a retry after a successful post but before thread-commit must NOT re-post the same comment", async () => {
    const db = freshMemDb();
    const service = createReviewService({ db, auditKey: KEY, now: clock });
    const repo = await service.upsertRepo({
      userId: "user_1",
      owner: "acme",
      name: "web",
      installationId: "42",
    });
    // Seed a queued pr_review + the existing PR comment that the FIRST (crashed)
    // run already posted to GitHub, carrying the hidden tensol:fp marker.
    const created = await service.createQueuedReviewWithJob(
      { repoId: repo.id, userId: "user_1", kind: "pr", prNumber: 7, headSha: "abc123" },
      "pr_review",
    );
    const reviewId = created.review.id;

    // Fingerprint the engine will produce for the SQLi finding — copy GitHub's
    // existing-comment body so a GitHub-state reconciliation WOULD skip it.
    const github = new FakeGitHubClient({
      files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
    });
    const llm = new FakeLlmClient(sqliResponder);
    const handle = createPrReviewHandler({ service, github, llm });

    // RUN #1: post to GitHub succeeds, but the thread-commit step "crashes"
    // (we stub upsertThread to throw once) — exactly the gap 20a454d closed.
    let upsertCalls = 0;
    const origUpsert = service.upsertThread.bind(service);
    (service as { upsertThread: typeof service.upsertThread }).upsertThread = async (args) => {
      upsertCalls += 1;
      if (upsertCalls === 1) throw new Error("simulated crash before thread row committed");
      return origUpsert(args);
    };
    let run1Threw = false;
    try {
      await handle("job-1", { reviewId });
    } catch {
      run1Threw = true;
    }
    const postsAfterRun1 = github.postReviewCalls.length;
    console.log("HIGH-4 run#1 threw:", run1Threw, "posts after run#1:", postsAfterRun1);

    // The runner re-dispatches the SAME review (it's `failed`, not `completed`,
    // so the handler re-runs). The local thread row was never committed.
    await handle("job-1-retry", { reviewId });
    const postsAfterRetry = github.postReviewCalls.length;
    const totalComments = github.postReviewCalls.reduce(
      (n, c) => n + (Array.isArray(c.comments) ? c.comments.length : 0),
      0,
    );
    console.log(
      "HIGH-4 posts after retry:",
      postsAfterRetry,
      "total inline comments posted across runs:",
      totalComments,
      "listReviewComments on client:",
      typeof (github as unknown as { listReviewComments?: unknown }).listReviewComments,
    );

    // Hardened (20a454d): retry reconciles GitHub state -> 0 NEW comments on retry.
    // Reverted: no GitHub-state reconciliation -> the same inline comment is
    // posted AGAIN (duplicate review-comment spam on every retry).
    expect(
      postsAfterRetry,
      "retry must NOT issue a second postReview (it would duplicate the inline comment)",
    ).toBe(postsAfterRun1);
  });
});

// ==========================================================================
// HIGH-5 — OpenRouter AbortController 90s timeout
// 20a454d: injectable timeoutMs (default 90s) via AbortController -> a stalled
// upstream throws instead of hanging POST /v1/review forever.
// Working tree: timeoutMs + AbortController removed -> complete() hangs.
// ==========================================================================
describe("HIGH-5 OpenRouter call timeout", () => {
  test("PROBE: a stalled upstream must make complete() reject within a bounded time, not hang", async () => {
    // A fetch that NEVER resolves => a half-open upstream.
    const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3.7-max",
      fetchImpl: hangingFetch,
      // 20a454d exposed `timeoutMs`; if it still exists we pass a tiny value.
      ...({ timeoutMs: 200 } as Record<string, unknown>),
    });

    let settled: "rejected" | "resolved" | "timed-out-waiting" = "timed-out-waiting";
    const completePromise = client
      .complete({ system: "s", user: "u" })
      .then(() => {
        settled = "resolved";
      })
      .catch(() => {
        settled = "rejected";
      });
    // Bounded race: a hardened client aborts at ~200ms; give it 1500ms slack.
    const watchdog = new Promise<void>((r) => setTimeout(r, 1500));
    await Promise.race([completePromise, watchdog]);
    console.log("HIGH-5 complete() settled within 1500ms?", settled);

    // Hardened (20a454d): rejected (AbortController fired). Reverted: still
    // "timed-out-waiting" because complete() is hung on the never-resolving fetch.
    expect(
      settled,
      "complete() must reject on a stalled upstream (AbortController timeout); a hung promise pins POST /v1/review + jobs in `running`",
    ).toBe("rejected");
  });
});

// ==========================================================================
// HIGH-6 — parseAddedHunks must keep ++/-- content lines
// 20a454d: removed the dead `+++`/`---` guards — every `+`-line in the body is
// a genuine added line, INCLUDING added content beginning with `++` (TOML +++
// fence, C `++counter;`). Working tree re-added `!startsWith("+++")`.
// ==========================================================================
describe("HIGH-6 parseAddedHunks ++/-- content", () => {
  test("PROBE: an added line whose content begins with '++' must be kept in the snippet", () => {
    // Diff body from the first @@ onward. The added line's CONTENT is `++counter;`
    // so the raw diff line is `+` + `++counter;` = `+++counter;`.
    const patch = [
      "@@ -1,2 +1,3 @@",
      " line a",
      "+++counter;", // added content "++counter;" — a real C/TOML increment line
      " line b",
    ].join("\n");
    const hunks = parseAddedHunks(patch);
    const snippet = hunks.map((h) => h.snippet).join("\n");
    console.log("HIGH-6 hunks:", JSON.stringify(hunks));
    // Hardened: snippet contains "++counter;". Reverted: the `+++` guard drops it,
    // so the added line is silently MISSING from the review candidate -> false negative.
    expect(
      snippet.includes("++counter;"),
      "added content beginning with '++' (diff line '+++...') must be captured, not dropped as a file header",
    ).toBe(true);
  });
});

// ==========================================================================
// HIGH-7 — Sync POST /v1/review must include status
// 20a454d: resultToWire adds status:"completed" (required by ReviewResultWire).
// Working tree: status removed from resultToWire.
// ==========================================================================
describe("HIGH-7 sync POST status field", () => {
  test("PROBE: the sync POST / response must carry status", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log("HIGH-7 sync POST keys:", Object.keys(body).sort().join(","), "status:", body.status);
    expect(body.status, "sync POST response MUST include status (ReviewResultWire requires it)").toBe(
      "completed",
    );
  });
});

// ==========================================================================
// MED-8 — char-vs-byte caps + aggregate cap + Hono bodyLimit (413)
// 20a454d: per-field Buffer.byteLength refinements + MAX_TOTAL_REVIEW_BYTES
// .refine + a bodyLimit(413). Working tree reverted to z.string().max() (UTF-16
// code-unit count) + removed aggregate cap + removed bodyLimit.
// ==========================================================================
describe("MED-8 byte caps + aggregate cap + bodyLimit", () => {
  test("PROBE: a CJK patch under the .max() char cap but OVER the byte cap must be rejected (422)", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    // MAX_PATCH_BYTES = 512*1024 bytes. A 3-byte CJK char repeated 300_000 times
    // is 300_000 UTF-16 units (< 512Ki .max()) but 900_000 bytes (> 512Ki bytes).
    const cjk = "中".repeat(300_000);
    const patch = `@@ -1,1 +1,2 @@\n+${cjk}`;
    const charLen = patch.length;
    const byteLen = Buffer.byteLength(patch, "utf8");
    console.log("MED-8 patch chars:", charLen, "bytes:", byteLen, "(cap 524288)");
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/x.ts", status: "modified", patch }],
      }),
    });
    console.log("MED-8 status (422 = byte cap enforced):", res.status);
    // Hardened: Buffer.byteLength refinement -> 422. Reverted: .max() counts
    // UTF-16 units -> the 900KB CJK patch slips through (<512Ki chars) -> 200/503.
    expect(res.status, "a sub-char-cap but over-byte-cap CJK patch must be rejected (byte caps)").toBe(
      422,
    );
  });
});

// ==========================================================================
// MED-10 — clone_url dead field removal on whitebox launch schema
// 20a454d removed clone_url (validated-but-dead). Working tree re-added it.
// ==========================================================================
describe("MED-10 whitebox clone_url dead field", () => {
  test("PROBE: clone_url should be a known-removed field (re-added => dead field is back)", async () => {
    const db = freshMemDb();
    const { app } = makeReviewApp(db);
    // If clone_url is back in the schema, this validates+launches (202); the
    // value is still ignored downstream (no private-clone path exists).
    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api", ref: "main", clone_url: "https://x/y.git" }),
    });
    console.log("MED-10 whitebox+clone_url status:", res.status, "(202 => clone_url accepted again)");
    // This is informational: 202 confirms the dead field is back (validated then
    // ignored). We assert the 20a454d intent (field should NOT be a meaningful
    // accepted input). A strict schema would 422 an unknown field, but the schema
    // is non-strict; so we only record the classification, not fail the suite.
    expect([202, 422, 503]).toContain(res.status);
  });
});

// ==========================================================================
// LOW-11 — SARIF cleanUri percent-decode
// 20a454d: cleanUri percent-decodes (src/my%20report.ts -> src/my report.ts)
// so fingerprints + GitHub anchors match the real path. Working tree removed
// the decodeURIComponent.
// ==========================================================================
describe("LOW-11 SARIF percent-decode", () => {
  test("PROBE: a percent-encoded SARIF uri must be decoded to the real on-disk path", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { rules: [] } },
          results: [
            {
              ruleId: "X",
              level: "error",
              message: { text: "m" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/my%20report.ts" },
                    region: { startLine: 3 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const out = normalizeSarif(sarif, "opengrep" as never);
    console.log("LOW-11 normalized filePath:", JSON.stringify(out[0]?.filePath));
    // Hardened: "src/my report.ts". Reverted: "src/my%20report.ts" (encoded) ->
    // fingerprint + GitHub anchor never match the real file path.
    expect(out[0]?.filePath, "SARIF uri must be percent-decoded to the real path").toBe(
      "src/my report.ts",
    );
  });
});

// ==========================================================================
// LOW-13 — Unified finding serializer (single source of truth, no `side` drift)
// 20a454d: sync POST and GET detail both route through findingToWire so `side`
// can't drift. Working tree inlined two serializers: detail INCLUDES `side`,
// sync OMITS `side`. This probe proves the drift directly.
// ==========================================================================
describe("LOW-13 findingToWire single-source-of-truth (side drift)", () => {
  test("PROBE: the `side` field must be present+consistent on BOTH sync POST and GET detail", async () => {
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
    const sync = (await created.json()) as {
      review_id: string;
      findings: Array<Record<string, unknown>>;
    };
    const detail = (await (await app.request(`/${sync.review_id}`)).json()) as {
      findings: Array<Record<string, unknown>>;
    };
    const syncHasSide = "side" in (sync.findings[0] ?? {});
    const detailHasSide = "side" in (detail.findings[0] ?? {});
    console.log(
      "LOW-13 sync finding keys:",
      Object.keys(sync.findings[0] ?? {}).sort().join(","),
    );
    console.log(
      "LOW-13 detail finding keys:",
      Object.keys(detail.findings[0] ?? {}).sort().join(","),
    );
    console.log("LOW-13 syncHasSide:", syncHasSide, "detailHasSide:", detailHasSide);
    // Hardened: both true (one mapper). Reverted: detail true, sync false = DRIFT.
    expect(
      syncHasSide === detailHasSide,
      "`side` must not drift between the sync POST and GET detail serializers",
    ).toBe(true);
  });
});
