/**
 * CONTRACT CONFORMANCE PROBE — DO NOT MERGE
 *
 * Verifies that the server's HTTP response shapes match what consumers read.
 * Consumers:
 *   - apps/site/src/lib/api-client.ts  (ReviewResultWire, ReviewFindingWire, ReviewRepoWire)
 *   - apps/site/src/pages/Reviews.tsx  (r.review_id, r.findings.length, r.repo, r.pr_number,
 *                                        r.score_0_5, r.status, r.kind, r.created_at)
 *   - apps/site/src/pages/ReviewDetail.tsx (data.review_id, data.findings, f.fingerprint,
 *                                           f.file_path, f.start_line, f.severity, f.cwe,
 *                                           f.cvss_score, f.confidence, f.reachable,
 *                                           f.category, f.source, f.title, f.rationale_md,
 *                                           f.poc_md, f.fix_prompt_md, f.side,
 *                                           data.score_0_5, data.summary_md, data.status,
 *                                           data.kind, data.repo, data.pr_number)
 *   - .claude/skills/tensol-loop/references/api.md (review_id, status, findings[].side in sync POST)
 *
 * Server routes:
 *   GET /  → review.ts:282-300  (listReviewsByUser)
 *   GET /:id → review.ts:305-328
 *   GET /repos → review.ts:261-277
 *   POST / → review.ts:197-254 (resultToWire)
 *   POST /whitebox → review.ts:333-383
 */

import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";

import { createDb, type DB } from "../db/client.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createReviewService } from "../review/service.ts";
import { FakeLlmClient } from "../review/reviewer.ts";
import { createReviewRouter } from "../routes/review.ts";

// ─── Harness (mirrors review.test.ts exactly) ─────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "probe-key-0123456789abcdef0123456789abcdef";

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

let clockNow = 1_700_100_000_000;
const clock = () => clockNow++;

function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("probe_user_1", "probe@x.io", clockNow);
  return db;
}

const fakeAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("user", { id: "probe_user_1", email: "probe@x.io" });
  c.set("session", { id: "s_probe", user_id: "probe_user_1", expires_at: clockNow + 1e9 });
  await next();
};

// LLM stub that returns a finding with `side` field to exercise the wire serializer.
function sqliResponder(): string {
  return JSON.stringify({
    summary: "SQL injection found in db.ts.",
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
        poc_md: "' OR 1=1--",
        fix_prompt_md: "Use parameterized queries.",
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

function makeApp(db: DB) {
  const service = createReviewService({ db, auditKey: KEY, now: clock });
  const app = createReviewRouter({
    db,
    service,
    requireAuth: fakeAuth,
    llm: new FakeLlmClient(sqliResponder),
    now: clock,
  });
  return { app, service };
}

// ─── Probe 1: GET / (list) ─────────────────────────────────────────────────────
//
// Consumer reads (Reviews.tsx:261, 275, 282, 286, 291, 298, 302, 261):
//   r.review_id  — used as React key AND Link href
//   r.findings.length  — "Findings" column (r.findings must be an ARRAY)
//   r.repo   — "Repository" column (slug like "owner/name")
//   r.pr_number  — appended to repo label when non-null
//   r.score_0_5  — ScoreBadge
//   r.status  — StatusChip
//   r.kind  — kindLabel / kindTone
//   r.created_at  — fmtTimestamp
//
// Server emits (review.ts:286-299):
//   id, repo_id, kind, pr_number, head_sha, status, score_0_5,
//   findings_count, created_at, completed_at
//
// KNOWN DRIFT (seeded by orchestrator):
//   - server emits `id`, consumer reads `review_id`
//   - server emits `findings_count` (number), consumer reads `r.findings.length`
//     (requires array — `undefined.length` throws)
//   - server emits `repo_id` (foreign-key ID), consumer reads `r.repo` (slug string)

describe("PROBE: GET / (list) — Reviews.tsx field access", () => {
  test("DRIFT-1: server emits `id`, consumer reads `review_id` (Reviews.tsx:261 key + href)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    // Seed a completed review via POST /
    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        pr: 7,
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);

    const item = items[0]!;

    // --- CONFIRMED BUG: `review_id` MISSING ---
    // Reviews.tsx:261 uses `r.review_id` as React key + Link href:
    //   <tr key={r.review_id} ...>
    //   <Link to={`/reviews/${encodeURIComponent(r.review_id)}`}>
    // When undefined, the key is "undefined" (React de-duplication bug) and the
    // href becomes "/reviews/undefined".
    expect(item).toHaveProperty("review_id");       // WILL FAIL — server emits `id`
    expect(item).not.toHaveProperty("id");           // server emits `id`, not `review_id`
  });

  test("DRIFT-2: server emits `findings_count` (number), consumer reads `r.findings.length` (array access crashes)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });

    const res = await app.request("/");
    const items = (await res.json()) as Record<string, unknown>[];
    const item = items[0]!;

    // Reviews.tsx:282:  {r.findings.length}
    // `r.findings` is undefined → TypeError: Cannot read properties of undefined (reading 'length')
    expect(item).toHaveProperty("findings");         // WILL FAIL — server emits `findings_count`
    expect(Array.isArray(item["findings"])).toBe(true); // WILL FAIL — it's a number, not array
  });

  test("DRIFT-3: server emits `repo_id` (FK id), consumer reads `r.repo` (slug string)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        pr: 7,
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });

    const res = await app.request("/");
    const items = (await res.json()) as Record<string, unknown>[];
    const item = items[0]!;

    // Reviews.tsx:255-259:
    //   const repoLabel = r.repo ? (r.pr_number != null ? `${r.repo} #${r.pr_number}` : r.repo) : '—';
    // r.repo is undefined → repoLabel = '—' (no crash, but wrong display — shows '—' not "acme/web")
    expect(item).toHaveProperty("repo");             // WILL FAIL — server emits `repo_id`
    expect(typeof item["repo"]).toBe("string");      // would need to be a slug like "owner/name"
    // Verify what IS emitted so the bug is fully documented
    expect(item).toHaveProperty("repo_id");          // server emits this (FK uuid)
  });
});

// ─── Probe 2: GET /:id (detail) ────────────────────────────────────────────────
//
// Consumer reads (ReviewDetail.tsx):
//   data.review_id  — not directly read (page uses URL param `id`), but ReviewResultWire type requires it
//   data.findings   — FindingsSection reads findings.length + iterates with f.fingerprint as key
//   data.score_0_5  — ScoreBadge
//   data.summary_md — MarkdownRenderer
//   data.status     — StatusChip + isTerminal + polling stop
//   data.kind       — kindLabel / kindTone
//   data.repo       — repoLabel construction (ReviewDetail.tsx:389-394)
//   data.pr_number  — appended to repo label
//
//   Each finding (f):
//     f.fingerprint — React key (FindingCard key={f.fingerprint})
//     f.file_path, f.start_line — location string
//     f.severity — SeverityChip
//     f.category — InlineBadge
//     f.cvss_score — InlineBadge
//     f.confidence — InlineBadge
//     f.reachable — InlineBadge
//     f.source — InlineBadge
//     f.cwe[] — InlineBadge map
//     f.rationale_md — MarkdownRenderer
//     f.poc_md — Collapsible
//     f.fix_prompt_md — Collapsible
//     f.side — defined in ReviewFindingWire type (api-client.ts:501)
//
// Server emits (review.ts:311-328):
//   id (NOT review_id), repo_id, kind, pr_number, head_sha, status, score_0_5,
//   summary_md, findings_count, error, created_at, completed_at
//   findings[]: findingRowToWire() → includes `id` extra, `lifecycle_state` extra, `side` ✓

describe("PROBE: GET /:id (detail) — ReviewDetail.tsx + ReviewResultWire shape", () => {
  test("DRIFT-4: GET /:id emits `id` not `review_id` — ReviewResultWire.review_id missing", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/api",
        pr: 3,
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const { review_id } = (await postRes.json()) as { review_id: string };

    const res = await app.request(`/${review_id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;

    // api-client.ts:516: ReviewResultWire.review_id is required
    // ReviewDetail.tsx does NOT directly deref data.review_id (uses URL param),
    // but the type contract is broken — and api-client.review.get() returns ReviewResultWire.
    expect(detail).toHaveProperty("review_id");     // WILL FAIL — server emits `id`
  });

  test("DRIFT-5: GET /:id emits `repo_id` not `repo` — ReviewDetail.tsx:389-394 repoLabel shows '—'", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/api",
        pr: 3,
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const { review_id } = (await postRes.json()) as { review_id: string };

    const res = await app.request(`/${review_id}`);
    const detail = (await res.json()) as Record<string, unknown>;

    // ReviewDetail.tsx:389: const repoLabel = data ? (data.repo ? ...) : '—'
    // data.repo is undefined → page title shows '—' instead of "acme/api"
    expect(detail).toHaveProperty("repo");           // WILL FAIL — server emits `repo_id`
    expect(detail).not.toHaveProperty("repo_id");    // server actually emits this
  });

  test("DRIFT-6: GET /:id findings have `lifecycle_state` extra field (not in ReviewFindingWire) — harmless but docs the server adds extra", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/api",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const { review_id } = (await postRes.json()) as { review_id: string };

    const res = await app.request(`/${review_id}`);
    const detail = (await res.json()) as { findings: Record<string, unknown>[] };
    expect(detail.findings.length).toBeGreaterThan(0);
    const f = detail.findings[0]!;

    // findingRowToWire (review.ts:92-141) emits `lifecycle_state` — not in ReviewFindingWire
    // Not a crash but documents the server surface exceeds the declared type.
    // api-client.ts:496-514 ReviewFindingWire has no `lifecycle_state` field.
    expect(f).toHaveProperty("lifecycle_state");     // passes — but this field is UNDECLARED in wire type

    // Also confirm `side` IS present (required by ReviewFindingWire:501 and api.md:40)
    expect(f).toHaveProperty("side");                // should PASS
    expect(f["side"]).toMatch(/^(LEFT|RIGHT)$/);     // should PASS
  });

  test("CONFIRMED: GET /:id findings also have an extra `id` field not in ReviewFindingWire", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/api",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const { review_id } = (await postRes.json()) as { review_id: string };

    const res = await app.request(`/${review_id}`);
    const detail = (await res.json()) as { findings: Record<string, unknown>[] };
    const f = detail.findings[0]!;

    // findingRowToWire emits `id` (review.ts:121) — not in ReviewFindingWire
    // Low severity: consumers use `fingerprint` as the React key, not `id`.
    expect(f).toHaveProperty("id");                  // passes — extra undeclared field

    // `fingerprint` IS present — good (ReviewDetail.tsx:349 uses it as React key)
    expect(f).toHaveProperty("fingerprint");         // should PASS
  });
});

// ─── Probe 3: POST / (sync) response ──────────────────────────────────────────
//
// resultToWire (review.ts:144-169) emits:
//   review_id, kind, score_0_5, summary_md, findings[]
// MISSING from resultToWire:
//   status — required by ReviewResultWire (api-client.ts:519) and api.md:29
//   repo   — required by ReviewResultWire (api-client.ts:523)
//   created_at — required by ReviewResultWire (api-client.ts:524)
// findings[] from resultToWire (line 151-168):
//   does NOT include `side` — but ReviewFindingWire:501 marks it required

describe("PROBE: POST / (sync) — resultToWire shape vs ReviewResultWire", () => {
  test("DRIFT-7: POST / response missing `status` field (ReviewResultWire.status required, api.md:29)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // api-client.ts:519: status: ReviewRunStatus (required, non-optional)
    // api.md:29: "status": "completed" in the example response
    // resultToWire (review.ts:144-169) does NOT include `status`
    expect(body).toHaveProperty("status");           // WILL FAIL — resultToWire omits status
  });

  test("DRIFT-8: POST / findings missing `side` field (ReviewFindingWire.side required)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const body = (await res.json()) as { findings: Record<string, unknown>[] };
    expect(body.findings.length).toBeGreaterThan(0);
    const f = body.findings[0]!;

    // api-client.ts:501: side: "LEFT" | "RIGHT"  (required, not optional)
    // api.md:40: "side": "RIGHT" in the example
    // resultToWire (review.ts:151-168) does NOT include `side`
    expect(f).toHaveProperty("side");                // WILL FAIL — resultToWire omits side
  });

  test("DRIFT-9: POST / response missing `repo` field (ReviewResultWire.repo required by consumer)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        pr: 5,
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    // ReviewResultWire.repo (api-client.ts:523) used by ReviewDetail.tsx:389
    // resultToWire (review.ts:144-169) does NOT include `repo`
    expect(body).toHaveProperty("repo");             // WILL FAIL — resultToWire omits repo
  });

  test("DRIFT-10: POST / response missing `created_at` field (ReviewResultWire.created_at present)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: "acme/web",
        files: [{ path: "src/db.ts", status: "modified", patch: sqliPatch }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    // ReviewResultWire.created_at (api-client.ts:524)
    // resultToWire does NOT include created_at
    expect(body).toHaveProperty("created_at");       // WILL FAIL — resultToWire omits created_at
  });
});

// ─── Probe 4: GET /repos ───────────────────────────────────────────────────────
//
// Consumer reads (Reviews.tsx:176-183):
//   repo.owner, repo.name — display as "{owner}/{name}"
//   repo.scm  — display uppercase
//   repo.status — StatusChip
//   repo.id — React key
//
// ReviewRepoWire (api-client.ts:529-538):
//   id, scm, owner, name, default_branch, status, installation_id?, created_at?
//
// Server emits (review.ts:265-276):
//   id, scm, owner, name, full_name, default_branch, status, created_at
// Note: server adds `full_name` (not in wire type) — harmless extra.
// Server OMITS: `installation_id` — present in ReviewRepoWire as optional, so no crash.

describe("PROBE: GET /repos — ReviewRepoWire shape", () => {
  test("CONFORMANT: GET /repos emits all required ReviewRepoWire fields for Reviews.tsx", async () => {
    const db = freshMemDb();
    const { app, service } = makeApp(db);

    // Seed a repo directly via the service
    await service.upsertRepo({
      userId: "probe_user_1",
      owner: "acme",
      name: "web",
      scm: "github",
      installationId: "inst_42",
    });

    const res = await app.request("/repos");
    expect(res.status).toBe(200);
    const repos = (await res.json()) as Record<string, unknown>[];
    expect(repos.length).toBeGreaterThan(0);
    const r = repos[0]!;

    // Required by Reviews.tsx and ReviewRepoWire
    expect(r).toHaveProperty("id");            // ✓
    expect(r).toHaveProperty("scm");           // ✓
    expect(r).toHaveProperty("owner");         // ✓
    expect(r).toHaveProperty("name");          // ✓
    expect(r).toHaveProperty("default_branch"); // ✓
    expect(r).toHaveProperty("status");        // ✓
    expect(r).toHaveProperty("created_at");    // ✓

    // `installation_id` in ReviewRepoWire but NOT in server response — optional so no crash
    // Document: server emits `full_name` which is extra (not in ReviewRepoWire type)
    expect(r).toHaveProperty("full_name");     // extra — undeclared in ReviewRepoWire
  });
});

// ─── Probe 5: POST /whitebox ───────────────────────────────────────────────────
//
// Consumer (api-client.ts:581): expects { review_id: string }
// Server emits (review.ts:382): { review_id, job_id, status }
// The consumer type is { review_id: string } — server adds `job_id` and `status`
// which are extra (not a breaking drift — consumer only reads review_id).
// But `status` is important for the skill: api.md:55 expects `{ "review_id": "01J...", "status": "queued" }`

describe("PROBE: POST /whitebox — wire shape vs api-client + api.md", () => {
  test("CONFORMANT: POST /whitebox returns review_id (required by api-client.ts:581)", async () => {
    const db = freshMemDb();
    const { app } = makeApp(db);

    const res = await app.request("/whitebox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/api", ref: "main" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;

    // api-client.ts:581: Promise<{ review_id: string }>
    expect(body).toHaveProperty("review_id");   // ✓ server emits this
    expect(typeof body["review_id"]).toBe("string"); // ✓

    // api.md:55: "status": "queued" expected
    expect(body).toHaveProperty("status");      // ✓ server emits this
    expect(body["status"]).toBe("queued");       // ✓
  });
});
