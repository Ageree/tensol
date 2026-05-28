/**
 * Test-only fixture-seeder endpoints (`/__test/v2/*`).
 *
 * MOUNT GATE: ONLY when `config.NODE_ENV !== "production"`.
 *
 * Purpose
 *   Unblock the Playwright e2e suite (T091/T092/T093/T112/T120 → T149) by
 *   giving the frontend specs a fast-forward escape hatch into mid-flight
 *   fixture state — no need to drive the real magic-link / DNS-resolver /
 *   real-VM / real-LLM stack just to assert a UI branch.
 *
 *   The contract (request + response shape per endpoint) is documented
 *   verbatim in `apps/site/e2e/helpers/scan-wizard-helpers.ts` (commit
 *   2d74f15 + 529916b). Keep both files in sync.
 *
 * Endpoints (7)
 *   POST /__test/v2/seed-session            { email }
 *   POST /__test/v2/exhaust-quota           { user_id }
 *   POST /__test/v2/expire-dns-verify       { order_id }
 *   POST /__test/v2/create-dns-pending      { user_id, primary_domain }
 *   POST /__test/v2/create-dns-verified     { user_id, primary_domain, rps? }
 *   POST /__test/v2/seed-completed-scan     { user_id, primary_domain?, findings_count?, report_status? }
 *   POST /__test/v2/expire-report           { report_id }
 *
 * Constitution checklist
 *   - I:    no `external/decepticon/*` touched.
 *   - VII:  this file ≤ 800 LOC.
 *   - IX:   every body Zod-validated; bad payload → 422.
 *   - X:    NO signed audit emit — these are test endpoints and any audit
 *           row here would pollute the production audit chain when the gate
 *           is mis-set. The spec for these endpoints is "raw fixture DB
 *           writes only".
 *
 * Security posture
 *   The router is constructed only when `NODE_ENV !== "production"`. The
 *   factory itself does NOT re-read the env — the caller (server.ts) owns
 *   the gate. Mounting this in production would leak session-minting +
 *   quota-bypass + DB-state-rewriting capabilities to anonymous callers;
 *   the boot path makes the mount explicitly conditional.
 */
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "../db/client.ts";
import { ulid } from "../lib/ids.ts";
import { now as defaultNow } from "../lib/time.ts";
import {
  users as usersTable,
  sessions as sessionsTable,
  scanOrders as scanOrdersTable,
  scans as scansTable,
  findings as findingsTable,
  reports as reportsTable,
} from "../db/schema.ts";
import { generateToken } from "../dns-verify/service.ts";

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

export interface CreateTestV2RouterDeps {
  readonly db: DB;
  /** Clock injection — defaults to system `Date.now()` via `lib/time.ts`. */
  readonly now?: () => number;
  /** ULID factory injection — defaults to `lib/ids.ts.ulid()`. */
  readonly newId?: () => string;
}

// ---------------------------------------------------------------------------
// Zod bodies — narrow per endpoint, all snake_case to mirror the e2e helper
// contract and the wider `/v1/*` API.
// ---------------------------------------------------------------------------

const SeedSessionBody = z.object({
  email: z.string().min(1).max(320),
});

const ExhaustQuotaBody = z.object({
  user_id: z.string().min(1).max(64),
});

const ExpireDnsVerifyBody = z.object({
  order_id: z.string().min(1).max(64),
});

const CreateDnsPendingBody = z.object({
  user_id: z.string().min(1).max(64),
  primary_domain: z.string().min(1).max(253),
});

const CreateDnsVerifiedBody = z.object({
  user_id: z.string().min(1).max(64),
  primary_domain: z.string().min(1).max(253),
  rps: z.number().int().min(1).max(500).optional(),
});

const ReportStatusEnum = z.enum(["pending", "rendering", "ready", "failed"]);

const SeedCompletedScanBody = z.object({
  user_id: z.string().min(1).max(64),
  primary_domain: z.string().min(1).max(253).optional(),
  findings_count: z.number().int().min(0).max(1000).optional(),
  report_status: ReportStatusEnum.optional(),
});

const ExpireReportBody = z.object({
  report_id: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// Severity cycle for deterministic seeded findings.
// Matches the Juice Shop fixture shape distribution.
// ---------------------------------------------------------------------------
const SEVERITY_CYCLE = [
  "critical",
  "critical",
  "critical",
  "high",
  "high",
  "high",
  "high",
  "medium",
  "medium",
] as const;

type Severity = (typeof SEVERITY_CYCLE)[number];

function pickSeverity(i: number): Severity {
  return SEVERITY_CYCLE[i % SEVERITY_CYCLE.length] ?? "medium";
}

// ---------------------------------------------------------------------------
// Validation helper — return Zod issues in a stable 422 envelope.
// ---------------------------------------------------------------------------
function badBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
):
  | { ok: true; data: T }
  | { ok: false; payload: { error: string; issues: unknown } } {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    payload: {
      error: "INVALID_BODY",
      issues: parsed.error.issues,
    },
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createTestV2Router(deps: CreateTestV2RouterDeps): Hono {
  const { db } = deps;
  const nowFn = deps.now ?? defaultNow;
  const newIdFn = deps.newId ?? (() => ulid(nowFn()));

  const app = new Hono();

  // -------------------------------------------------------------------------
  // POST /seed-session
  //   Insert a `users` row + an active `sessions` row. Returns the session id
  //   (which the spec drops into the Playwright cookie jar) plus the user id.
  // -------------------------------------------------------------------------
  app.post("/seed-session", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(SeedSessionBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { email } = v.data;
    const ts = nowFn();
    const userId = newIdFn();
    const sessionId = newIdFn();
    const expiresAt = ts + 24 * 60 * 60 * 1000; // +24h

    // Upsert-by-email: if a user already exists for this email, reuse it.
    // This matches the e2e helper assumption that calling seedSession twice
    // for the same email returns a usable session against the SAME user.
    const existing = db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .get();
    const effectiveUserId = existing?.id ?? userId;

    if (!existing) {
      db.insert(usersTable)
        .values({
          id: userId,
          email,
          createdAt: ts,
        })
        .run();
    }

    db.insert(sessionsTable)
      .values({
        id: sessionId,
        userId: effectiveUserId,
        createdAt: ts,
        expiresAt,
      })
      .run();

    return c.json(
      { session_id: sessionId, user_id: effectiveUserId },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // POST /exhaust-quota
  //   Mark `users.free_quick_consumed_at = now()` so the next launchScan
  //   call against this user returns 429 QUOTA_EXHAUSTED.
  // -------------------------------------------------------------------------
  app.post("/exhaust-quota", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(ExhaustQuotaBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { user_id } = v.data;
    const ts = nowFn();

    const user = db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .get();
    if (!user) return c.json({ error: "USER_NOT_FOUND" }, 404);

    db.update(usersTable)
      .set({
        freeQuickConsumedAt: ts,
        freeQuickConsumedCount: sql`${usersTable.freeQuickConsumedCount} + 1`,
      })
      .where(eq(usersTable.id, user_id))
      .run();

    return c.json({ ok: true, free_quick_consumed_at: ts }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /expire-dns-verify
  //   Backdate `scan_orders.dns_verify_requested_at` to ≥31 min ago so the
  //   next `checkVerification` call trips the 30-min hard cap and emits a
  //   signed `dns_verify_failed` audit (see dns-verify/service.ts §191).
  // -------------------------------------------------------------------------
  app.post("/expire-dns-verify", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(ExpireDnsVerifyBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { order_id } = v.data;
    const ts = nowFn();
    // 31 minutes in the past — comfortably past the 30-min cap.
    const backdated = ts - 31 * 60 * 1000;

    const order = db
      .select({ id: scanOrdersTable.id })
      .from(scanOrdersTable)
      .where(eq(scanOrdersTable.id, order_id))
      .get();
    if (!order) return c.json({ error: "ORDER_NOT_FOUND" }, 404);

    db.update(scanOrdersTable)
      .set({
        dnsVerifyRequestedAt: backdated,
        updatedAt: ts,
      })
      .where(eq(scanOrdersTable.id, order_id))
      .run();

    return c.json(
      { ok: true, dns_verify_requested_at: backdated },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // POST /create-dns-pending
  //   Skip wizard steps 1+2: create a `scan_orders` row already in
  //   `dns_pending` state with a fresh DNS-verify token + requestedAt anchor.
  // -------------------------------------------------------------------------
  app.post("/create-dns-pending", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(CreateDnsPendingBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { user_id, primary_domain } = v.data;
    const ts = nowFn();
    const orderId = newIdFn();
    const token = generateToken(orderId);

    const user = db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .get();
    if (!user) return c.json({ error: "USER_NOT_FOUND" }, 404);

    db.insert(scanOrdersTable)
      .values({
        id: orderId,
        userId: user_id,
        status: "dns_pending",
        tier: "quick",
        primaryDomain: primary_domain,
        attackSurfaceJson: JSON.stringify([
          { domain: primary_domain, primary: true, headers: [] },
        ]),
        safetyRps: 50,
        dnsVerifyToken: token,
        dnsVerifyRequestedAt: ts,
        dnsCheckAttempts: 0,
        vpsProvider: "yandex",
        paymentKind: "free_quick",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    return c.json({ order_id: orderId, dns_token: token }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /create-dns-verified
  //   Skip wizard steps 1-3: land directly in `dns_verified` with both
  //   `dns_verify_requested_at` AND `dns_verified_at` populated so the next
  //   `launchScan` call passes the status gate without polling.
  // -------------------------------------------------------------------------
  app.post("/create-dns-verified", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(CreateDnsVerifiedBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { user_id, primary_domain } = v.data;
    const rps = v.data.rps ?? 50;
    const ts = nowFn();
    const orderId = newIdFn();
    const token = generateToken(orderId);

    const user = db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .get();
    if (!user) return c.json({ error: "USER_NOT_FOUND" }, 404);

    db.insert(scanOrdersTable)
      .values({
        id: orderId,
        userId: user_id,
        status: "dns_verified",
        tier: "quick",
        primaryDomain: primary_domain,
        attackSurfaceJson: JSON.stringify([
          { domain: primary_domain, primary: true, headers: [] },
        ]),
        safetyRps: rps,
        dnsVerifyToken: token,
        dnsVerifyRequestedAt: ts - 60 * 1000,
        dnsVerifiedAt: ts,
        dnsCheckAttempts: 1,
        vpsProvider: "yandex",
        paymentKind: "free_quick",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    return c.json({ order_id: orderId }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /seed-completed-scan
  //   Atomically fabricate a full history row:
  //     - `scan_orders` in `completed`
  //     - sibling `scans` in `completed`
  //     - `findings_count` findings with cycled severities
  //     - `reports` in the requested status
  //
  //   Used by history-redownload.spec.ts to exercise Dashboard → row click
  //   → Findings → Report → expire → Regenerate without waiting for a real
  //   Decepticon scan.
  // -------------------------------------------------------------------------
  app.post("/seed-completed-scan", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(SeedCompletedScanBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { user_id } = v.data;
    const primaryDomain = v.data.primary_domain ?? "example.com";
    const findingsCount = v.data.findings_count ?? 9;
    const reportStatus = v.data.report_status ?? "ready";

    const user = db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .get();
    if (!user) return c.json({ error: "USER_NOT_FOUND" }, 404);

    const ts = nowFn();
    const orderId = newIdFn();
    const scanId = newIdFn();
    const reportId = newIdFn();
    const token = generateToken(orderId);

    // 1) scan_orders — completed, free_quick, with scanId backlink.
    db.insert(scanOrdersTable)
      .values({
        id: orderId,
        userId: user_id,
        status: "completed",
        tier: "quick",
        primaryDomain,
        attackSurfaceJson: JSON.stringify([
          { domain: primaryDomain, primary: true, headers: [] },
        ]),
        safetyRps: 50,
        dnsVerifyToken: token,
        dnsVerifyRequestedAt: ts - 10 * 60 * 1000,
        dnsVerifiedAt: ts - 9 * 60 * 1000,
        dnsCheckAttempts: 1,
        vpsProvider: "yandex",
        scanId,
        paymentKind: "free_quick",
        createdAt: ts - 10 * 60 * 1000,
        updatedAt: ts,
      })
      .run();

    // 2) scans — completed.
    db.insert(scansTable)
      .values({
        id: scanId,
        userId: user_id,
        scanOrderId: orderId,
        profile: "recon",
        status: "completed",
        failureReason: null,
        startedAt: ts - 8 * 60 * 1000,
        completedAt: ts - 1 * 60 * 1000,
        usageTokens: 50_000,
        usageUsdCents: 25,
      })
      .run();

    // 3) findings — deterministic id/severity cycle.
    for (let i = 0; i < findingsCount; i++) {
      const findingId = newIdFn();
      const severity = pickSeverity(i);
      const externalId = `FIND-${String(i + 1).padStart(3, "0")}`;
      const title = `Seeded ${severity} finding #${i + 1}`;
      const fmJson = JSON.stringify({
        id: externalId,
        severity,
        title,
        cwe: [],
        mitre: [],
      });
      db.insert(findingsTable)
        .values({
          id: findingId,
          scanId,
          externalId,
          severity,
          title,
          target: primaryDomain,
          cvssScore: null,
          cvssVector: null,
          cvssVersion: null,
          cweJson: "[]",
          mitreJson: "[]",
          confidence: "verified",
          phase: "exploit",
          agent: "exploit",
          bodyMd: `# ${title}\n\nSeeded by /__test/v2/seed-completed-scan.`,
          rawYamlJson: fmJson,
          evidenceKeysJson: "[]",
          discoveredAt: ts - (5 * 60 * 1000) + i * 1000,
          createdAt: ts - (5 * 60 * 1000) + i * 1000,
        })
        .run();
    }

    // 4) reports — requested status. For `ready` we set bucket/key/byteSize
    //    and a download_expires_at 30 min in the future so the UI shows the
    //    download CTA. For other statuses we leave those columns null so
    //    the UI shows the appropriate state copy.
    const isReady = reportStatus === "ready";
    const reportExpiresAt = isReady ? ts + 30 * 60 * 1000 : null;
    db.insert(reportsTable)
      .values({
        id: reportId,
        scanId,
        status: reportStatus,
        bucket: isReady ? "tensol-test-bucket" : null,
        key: isReady ? `reports/${reportId}.pdf` : null,
        byteSize: isReady ? 128_000 : null,
        renderAttempts: isReady ? 1 : 0,
        lastError: null,
        expiresAt: reportExpiresAt,
        createdAt: ts - 60 * 1000,
        updatedAt: ts,
      })
      .run();

    return c.json(
      {
        order_id: orderId,
        scan_id: scanId,
        report_id: reportId,
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // POST /expire-report
  //   Backdate `reports.expires_at` to 1 hour in the past + flip status to
  //   `failed` so the Reports.tsx state machine surfaces the regenerate
  //   affordance deterministically.
  // -------------------------------------------------------------------------
  app.post("/expire-report", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const v = badBody(ExpireReportBody, raw);
    if (!v.ok) return c.json(v.payload, 422);

    const { report_id } = v.data;
    const ts = nowFn();
    const expiresAt = ts - 60 * 60 * 1000;

    const report = db
      .select({ id: reportsTable.id })
      .from(reportsTable)
      .where(eq(reportsTable.id, report_id))
      .get();
    if (!report) return c.json({ error: "REPORT_NOT_FOUND" }, 404);

    db.update(reportsTable)
      .set({
        status: "failed",
        expiresAt,
        updatedAt: ts,
      })
      .where(eq(reportsTable.id, report_id))
      .run();

    return c.json({ ok: true, expires_at: expiresAt }, 200);
  });

  return app;
}
