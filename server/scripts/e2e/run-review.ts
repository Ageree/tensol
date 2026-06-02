/**
 * REAL end-to-end verification driver for Sthrip PR Review.
 *
 * Drives the FULL production job-handler path against a LIVE GitHub PR:
 *   queued review row → getPullRequestFiles (real PR diff over the API) →
 *   runReview (real engine: candidates → context → LLM judge → deterministic
 *   score → self-challenge → verification gate) → postReviewResult (real
 *   batched inline review + check-run/commit-status) → threads → finalize.
 *
 * Auth: a classic PAT (Ageree) via createPatGitHubClient — no GitHub App needed.
 * LLM: a deterministic sink-detector stub (no live model key locally).
 * Everything else (diff fetch, scoring, verification gate, comment posting,
 * threading, persistence) is the real product code over a real repo.
 *
 * Run:  GITHUB_TOKEN=$(gh auth token) bun run scripts/e2e/run-review.ts
 */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb, type DB } from "../../src/db/client.ts";
import { createReviewService } from "../../src/review/service.ts";
import { createPrReviewHandler } from "../../src/jobs/handlers/pr-review.ts";
import { createStubLlm } from "./stub-llm.ts";
import { createPatGitHubClient } from "./pat-client.ts";

const PAT = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const OWNER = process.env.E2E_OWNER ?? "Ageree";
const NAME = process.env.E2E_REPO ?? "sthrip-review-testbed";
const PR = Number(process.env.E2E_PR ?? "1");
const HEAD = process.env.E2E_HEAD ?? "01b741751152b0834bec2826127846dbab52314f";
const AUDIT_KEY = "e2e-audit-key-0123456789abcdef0123456789abcdef0123456789abcdef";

if (!PAT) {
  console.error("FATAL: no PAT. Run with GITHUB_TOKEN=$(gh auth token) ...");
  process.exit(2);
}

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/-->\s*statement-breakpoint/g, ""))
    .join("\n");
}
function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

async function main(): Promise<void> {
  const db = freshMemDb();
  let clock = 1_700_000_000_000;
  const now = () => clock++;
  const service = createReviewService({ db, auditKey: AUDIT_KEY, now });

  // Seed a connected user + repo (installationId is ignored by the PAT client).
  (db.$client as Database)
    .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .run("e2e_user", "e2e@sthrip.test", clock);
  const repo = await service.upsertRepo({
    userId: "e2e_user",
    owner: OWNER,
    name: NAME,
    installationId: "e2e-pat",
  });

  const review = await service.createReview({
    repoId: repo.id,
    userId: "e2e_user",
    kind: "pr",
    prNumber: PR,
    headSha: HEAD,
  });

  const github = createPatGitHubClient({ pat: PAT });
  const llm = createStubLlm();
  const handle = createPrReviewHandler({ service, github, llm, confidenceFloor: "medium" });

  console.log(`\n▶ Running REAL review: ${OWNER}/${NAME} PR #${PR} @ ${HEAD.slice(0, 7)}`);
  const t0 = Date.now();
  await handle("e2e-job", { reviewId: review.id });
  const ms = Date.now() - t0;

  const finalized = await service.getReview(review.id);
  const findings = await service.getReviewFindings(review.id);

  console.log(`\n=== REVIEW RESULT (${ms} ms) ===`);
  console.log(`status        : ${finalized?.status}`);
  console.log(`score (0-5)   : ${finalized?.score0to5}`);
  console.log(`findings      : ${findings.length}`);
  console.log(`check-run     : ${github.flags.checkRunFellBackToStatus ? "fell back to commit STATUS (PAT mode)" : "posted as check-run"}`);
  console.log(`\n--- findings ---`);
  for (const f of findings) {
    console.log(
      `  [${f.severity}] ${f.category} — ${f.filePath}:${f.startLine ?? "?"} ` +
        `(conf=${f.confidence}, verify=${f.verificationStatus}, reachable=${f.reachable})`,
    );
  }
  console.log(`\n--- summary markdown ---\n${finalized?.summaryMd ?? "(none)"}`);

  if (finalized?.status !== "completed") {
    console.error(`\nFATAL: review did not complete (status=${finalized?.status}, error=${finalized?.error})`);
    process.exit(1);
  }
  console.log(`\n✔ Review completed. Inspect the live PR: https://github.com/${OWNER}/${NAME}/pull/${PR}`);
}

main().catch((err) => {
  console.error("\nE2E driver threw:", err);
  process.exit(1);
});
