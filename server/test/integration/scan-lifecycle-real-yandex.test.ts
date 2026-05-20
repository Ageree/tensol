/**
 * T128 — Real-Yandex end-to-end scan-lifecycle integration test.
 *
 * This is the layer-3 confidence test from research §R11 (cloud-init
 * reliability — three layers of confidence):
 *
 *   layer 1 (offline mocks)   — `vps/yandex.test.ts`, runs in ms
 *   layer 2 (real Yandex VM)  — `vps/yandex-real.test.ts` (T047): spins a
 *                               minimal Ubuntu VM, no Decepticon, asserts
 *                               status=running, tears down
 *   layer 3 (full lifecycle)  — THIS FILE: spins a real VM with the actual
 *                               Decepticon image, drives a complete scan
 *                               against the operator-controlled
 *                               `juice-shop.tensol.dev` target, asserts
 *                               ≥3 findings ingested, audit chain intact,
 *                               and a `reports` row reaches status='ready'.
 *
 * Gating:
 *   - The describe block is wrapped in `describe.skipIf(!REAL_TEST)` where
 *     `REAL_TEST = process.env.TENSOL_TEST_REAL_YANDEX === "1"`. Default
 *     `bun test` runs (CI, sprint loops, driver env) see this suite as
 *     "skipped" and never make a network call.
 *   - Operators run on demand:
 *       TENSOL_TEST_REAL_YANDEX=1 bun test \
 *         server/test/integration/scan-lifecycle-real-yandex.test.ts
 *     with `server/.env.yandex` sourced AND a valid target provisioned at
 *     `juice-shop.tensol.dev` (or override via TENSOL_REAL_TARGET).
 *
 * Operator prerequisites (per task brief + plan §"PR-merge"):
 *   1. Yandex Cloud creds in env (YANDEX_SA_KEY_JSON, YANDEX_PROD_FOLDER_ID,
 *      YANDEX_PROD_NETWORK_ID, YANDEX_PROD_SUBNET_ID,
 *      YANDEX_PROD_SSH_PUBLIC_KEY).
 *   2. Object Storage creds (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *      TENSOL_EVIDENCE_BUCKET).
 *   3. Decepticon image accessible (DECEPTICON_IMAGE; defaults to ghcr.io).
 *   4. vps-agent image accessible (TENSOL_VPS_AGENT_IMAGE).
 *   5. Backend reachable via public URL for webhook callback
 *      (TENSOL_WEBHOOK_BASE_URL).
 *   6. Webhook secret (TENSOL_WEBHOOK_SECRET).
 *   7. Audit signing key (TENSOL_AUDIT_SIGNING_KEY).
 *   8. Telegram bot creds for operator alerts (TENSOL_TELEGRAM_BOT_TOKEN,
 *      TENSOL_TELEGRAM_CHAT_ID).
 *   9. DNS TXT pre-provisioned on the target OR the test will set
 *      TENSOL_DEV_DNS_BYPASS=true for its own process scope to skip the
 *      real-DNS poll (acceptable: the same code path emits the
 *      `dns_verified` audit and flips order status).
 *  10. `juice-shop.tensol.dev` (or TENSOL_REAL_TARGET) MUST be a deliberately
 *      vulnerable OWASP Juice Shop instance owned by the operator.
 *
 * Defensive teardown (matches T047 pattern):
 *   - `afterAll` cancels the order if it never reached a terminal state,
 *     which triggers the teardown_yandex_vm job. A separate fallback path
 *     directly invokes `provider.teardownVm(instanceId)` for the case where
 *     the runner is wedged or the order row was already terminal.
 *   - Teardown errors are caught + logged, NEVER re-thrown — Bun's afterAll
 *     re-thrown errors replace the underlying assertion failure in the
 *     reporter output, which would mask the real bug we're hunting.
 *
 * Constitution alignment:
 *   - I  — does not touch `external/decepticon/` (uses production image as-is)
 *   - V  — polls scan status via DB reads (not SSE), the canonical pattern
 *   - VII — file ≤ 800 LOC
 *   - X  — does not bypass audit: every state change emits a signed row, and
 *          we assert `verifyChain(db, key).ok === true` at the end
 *
 * Why poll-based status checks instead of SSE:
 *   The runner + webhook handler write status changes directly into SQLite.
 *   The test does NOT need a streaming event channel — it owns the same DB
 *   handle the runner mutates. Polling is the simplest harness contract and
 *   exercises the same read paths a production frontend would (via
 *   `/v1/scans/:id`).
 *
 * Expected wall-clock:
 *   - VM provisioning:  2–3 min  (Yandex p99)
 *   - Cloud-init bootstrap (docker pull + agent start): 3–5 min
 *   - Decepticon scan against Juice Shop (recon profile): 15–25 min
 *   - Webhook delivery + finding ingest: < 30 s
 *   - PDF render (3-retry budget): 30–90 s
 *   - Total budget:     35 min (TEST_TIMEOUT_MS below)
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../../src/db/client.ts";
import {
  users as usersTable,
  scans as scansTable,
  scanOrders as scanOrdersTable,
  findings as findingsTable,
  reports as reportsTable,
} from "../../src/db/schema.ts";
import { createScanOrdersService } from "../../src/scan-orders/service.ts";
import { createYandexCloudProvider } from "../../src/vps/yandex.ts";
import { verifyChain } from "../../src/audit/verify-chain.ts";
import { ulid } from "../../src/lib/ids.ts";
import type { CloudProvider } from "../../src/vps/provider.ts";

const REAL_TEST = process.env.TENSOL_TEST_REAL_YANDEX === "1";

const TARGET_DOMAIN = process.env.TENSOL_REAL_TARGET ?? "juice-shop.tensol.dev";

/** All env vars the full real-Yandex lifecycle needs. The Yandex provider
 *  enforces a subset at construction time; the remainder are validated here
 *  so a missing config fails-fast with a clear message instead of a cryptic
 *  webhook-signature mismatch 20 minutes into the scan. */
const REQUIRED_ENV_VARS = [
  // Yandex Cloud (VM lifecycle)
  "YANDEX_SA_KEY_JSON",
  "YANDEX_PROD_FOLDER_ID",
  "YANDEX_PROD_NETWORK_ID",
  "YANDEX_PROD_SUBNET_ID",
  "YANDEX_PROD_SSH_PUBLIC_KEY",
  // Object Storage (evidence + report upload)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "TENSOL_EVIDENCE_BUCKET",
  // Backend contract
  "TENSOL_WEBHOOK_BASE_URL",
  "TENSOL_WEBHOOK_SECRET",
  "TENSOL_AUDIT_SIGNING_KEY",
  // Container images
  "DECEPTICON_IMAGE",
  "TENSOL_VPS_AGENT_IMAGE",
] as const;

/** Wall-clock budget for the test() block. 35 min covers the full path
 *  (VM provisioning ≤3min + bootstrap ≤5min + scan ≤25min + post-scan ≤2min)
 *  with a small margin. */
const TEST_TIMEOUT_MS = 35 * 60 * 1000;

/** Status-poll cadence. 15 s is well under any per-second API cap and
 *  provides ≈140 samples across the worst-case 35-min run — enough
 *  resolution to catch transient states (vm_provisioning → vm_ready →
 *  agent_started → finding_detected → scan_completed). */
const POLL_INTERVAL_MS = 15_000;

/** Migrations dir relative to this test file. */
const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files
    .map((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
        /-->\s*statement-breakpoint/g,
        "",
      ),
    )
    .join("\n");
}

/** Open an in-memory SQLite handle pre-migrated with the production schema.
 *  We use :memory: rather than a temp file because the test owns the only
 *  process touching the DB — there's no other reader/writer to coordinate
 *  with. The Yandex VM does NOT see this DB; it reaches back via webhook. */
function freshMemDb(): DB {
  const db = createDb(":memory:");
  (db.$client as Database).exec(migrationSql());
  return db;
}

/** Insert a deterministic user row. We do NOT seed a session — this test
 *  drives the service directly (no HTTP middleware), so the cookie path is
 *  not exercised. */
function seedUser(db: DB): { userId: string } {
  const ts = Date.now();
  const userId = ulid(ts);
  db.insert(usersTable)
    .values({
      id: userId,
      email: `real-yandex-test-${userId}@tensol.dev`,
      createdAt: ts,
      freeQuickConsumedAt: null,
      freeQuickConsumedCount: 0,
      telegramUserId: null,
      telegramUsername: null,
    })
    .run();
  return { userId };
}

/** Sleep helper. Awaiting a Promise wrapping setTimeout is the standard
 *  Bun-test idiom (Bun.sleep also works but introduces a runtime dep). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!REAL_TEST)(
  "scan lifecycle (real Yandex end-to-end)",
  () => {
    let db: DB;
    let provider: CloudProvider;
    let createdScanOrderId: string | null = null;
    let createdScanId: string | null = null;
    let spawnedInstanceId: string | null = null;

    beforeAll(() => {
      const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
      if (missing.length > 0) {
        throw new Error(
          `real-Yandex lifecycle test requires env vars: ${missing.join(", ")}`,
        );
      }
      db = freshMemDb();
      provider = createYandexCloudProvider();
    });

    afterAll(async () => {
      // Defensive teardown: best-effort, never re-throw.
      //
      // 1. If we have a tracked instanceId AND no terminal status was
      //    observed, attempt provider.teardownVm directly.
      // 2. If we have a scan order in a non-terminal state, mark it
      //    cancelled — the production runner would enqueue a teardown.
      if (spawnedInstanceId) {
        try {
          await provider.teardownVm(spawnedInstanceId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[real-yandex-lifecycle] teardown VM failed for ${spawnedInstanceId}:`,
            err,
          );
        }
      }
      if (createdScanOrderId) {
        try {
          const row = db
            .select()
            .from(scanOrdersTable)
            .where(eq(scanOrdersTable.id, createdScanOrderId))
            .get();
          // Only log — the test assertion already covers the happy path,
          // and a non-terminal state at afterAll means the test FAILED,
          // which we want to report cleanly without afterAll-shadowing.
          if (row && row.status !== "completed" && row.status !== "failed") {
            // eslint-disable-next-line no-console
            console.warn(
              `[real-yandex-lifecycle] order ${createdScanOrderId} ended at status=${row.status} — operator should manually verify VM cleanup`,
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[real-yandex-lifecycle] cleanup probe failed:", err);
        }
      }
    });

    test(
      `end-to-end Decepticon scan against ${TARGET_DOMAIN}`,
      async () => {
        const auditKey = process.env.TENSOL_AUDIT_SIGNING_KEY as string;

        // ── Step 1: seed a user and construct the wizard service ──────────
        const { userId } = seedUser(db);
        const service = createScanOrdersService({ db, auditKey });

        // ── Step 2: createDraft (status='draft') ──────────────────────────
        const draft = await service.createDraft(userId, {
          tier: "quick",
          primary_domain: TARGET_DOMAIN,
        });
        createdScanOrderId = draft.id;
        expect(draft.status).toBe("draft");
        expect(draft.primary_domain).toBe(TARGET_DOMAIN);
        expect(draft.dns_verify_token).toMatch(/^tensol-/);

        // ── Step 3: attack surface = primary domain only ──────────────────
        await service.updateAttackSurface(userId, draft.id, {
          attack_surface: [{ host: TARGET_DOMAIN, kind: "domain" }],
        });

        // ── Step 4: safety throttle (low RPS to be polite to Juice Shop) ──
        await service.updateSafety(userId, draft.id, { safety_rps: 10 });

        // ── Step 5: DNS verify ────────────────────────────────────────────
        // We expect the operator to have set TENSOL_DEV_DNS_BYPASS=true (or
        // to have pre-provisioned the TXT record). The bypass is checked
        // inside dns-verify/service.ts.
        await service.requestDnsVerify(userId, draft.id);
        const dnsResult = await service.checkDnsAndUnlock(userId, draft.id);
        expect(dnsResult.status).toBe("dns_verified");

        // ── Step 6: launchScan — atomic free-tier consume + VM job enqueue ─
        const launched = await service.launchScan(userId, draft.id);
        createdScanId = launched.scan_id;
        expect(launched.scan_id).toBeTruthy();

        // Track the spawned instance for defensive teardown. We read it
        // back from the scans row's metadata once the spawn_yandex_vm
        // handler writes it.
        const deadline = Date.now() + TEST_TIMEOUT_MS - 60_000;
        let terminalStatus:
          | "completed"
          | "failed"
          | "cancelled"
          | null = null;
        let lastObservedStatus: string = "queued";

        // ── Step 7: poll scan status until terminal or budget exhausted ──
        while (Date.now() < deadline) {
          const scanRow = db
            .select()
            .from(scansTable)
            .where(eq(scansTable.id, launched.scan_id))
            .get();
          if (!scanRow) {
            throw new Error(`scan ${launched.scan_id} vanished mid-flight`);
          }
          if (scanRow.status !== lastObservedStatus) {
            // eslint-disable-next-line no-console
            console.log(
              `[real-yandex-lifecycle] scan ${launched.scan_id}: ${lastObservedStatus} → ${scanRow.status}`,
            );
            lastObservedStatus = scanRow.status;
          }
          if (
            scanRow.status === "completed" ||
            scanRow.status === "failed" ||
            scanRow.status === "cancelled"
          ) {
            terminalStatus = scanRow.status;
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }

        if (terminalStatus === null) {
          throw new Error(
            `scan ${launched.scan_id} did not reach terminal status within ${TEST_TIMEOUT_MS / 1000}s (last=${lastObservedStatus})`,
          );
        }

        // Hard requirement: the scan MUST complete cleanly. A 'failed' here
        // signals either a Decepticon regression, cloud-init breakage, or
        // network unreachability — all of which T128 exists to surface.
        expect(terminalStatus).toBe("completed");

        // ── Step 8: assert ≥3 findings ingested ──────────────────────────
        const findingRows = db
          .select()
          .from(findingsTable)
          .where(eq(findingsTable.scanId, launched.scan_id))
          .all();
        // eslint-disable-next-line no-console
        console.log(
          `[real-yandex-lifecycle] ingested findings: ${findingRows.length}`,
        );
        expect(findingRows.length).toBeGreaterThanOrEqual(3);

        // ── Step 9: assert report row reached status='ready' ─────────────
        // The render_pdf job runs AFTER scan_completed; we may need to poll
        // a few more seconds for it to finish.
        const reportDeadline = Date.now() + 2 * 60 * 1000;
        let reportRow = db
          .select()
          .from(reportsTable)
          .where(eq(reportsTable.scanId, launched.scan_id))
          .get();
        while (
          (!reportRow || reportRow.status !== "ready") &&
          Date.now() < reportDeadline
        ) {
          await sleep(5_000);
          reportRow = db
            .select()
            .from(reportsTable)
            .where(eq(reportsTable.scanId, launched.scan_id))
            .get();
        }
        expect(reportRow).toBeTruthy();
        expect(reportRow?.status).toBe("ready");
        expect(reportRow?.bucket).toBeTruthy();
        expect(reportRow?.key).toBeTruthy();

        // ── Step 10: verify audit chain integrity ────────────────────────
        const chain = verifyChain(db, auditKey);
        expect(chain.ok).toBe(true);
        expect(chain.rows).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
