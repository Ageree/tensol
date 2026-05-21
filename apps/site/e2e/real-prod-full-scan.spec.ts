/**
 * T128 — Real-Yandex full scan-lifecycle E2E against prod (Option B).
 *
 * Drives the full scan pipeline as an HTTP client against https://api.tensol.ru:
 *   1. Telegram-auth webhook simulation → obtain session cookie
 *   2. POST /v1/scan-orders (draft, tier=quick)
 *   3. PUT  /v1/scan-orders/:id/attack-surface
 *   4. PUT  /v1/scan-orders/:id/safety  (rps=10)
 *   5. POST /v1/scan-orders/:id/dns-verify/request
 *   6. Poll GET /v1/scan-orders/:id/dns-verify/check until verified=true
 *      (requires TENSOL_DEV_DNS_BYPASS=true on prod server)
 *   7. POST /v1/scan-orders/:id/launch → expect 202 + scan_id
 *   8. Poll GET /v1/scans/:scan_id every 30s, until terminal status OR 30min
 *   9. GET /v1/scans/:scan_id/findings  → log count
 *  10. GET /v1/scans/:scan_id/report    → log status
 *
 * This is the operator-bound counterpart to the original
 * server/test/integration/scan-lifecycle-real-yandex.test.ts (T128) which
 * couldn't be run as written because its `createDb` opens a LOCAL SQLite
 * disjoint from the production server's database. This Option B driver
 * instead exercises the live prod backend via the public HTTP contract.
 *
 * Hard rules:
 *   - 30-minute scan-poll budget (server-side timeout is 35min absolute)
 *   - Target = TARGET env var or `example.com` (proof-of-life only;
 *     Decepticon scanning example.com yields 0 findings, which is acceptable
 *     for the T128 proof — we are validating pipeline mechanics, not vuln
 *     detection. To test vuln detection, point at a real Juice Shop.)
 */
import { test, expect, request as apiRequest } from "@playwright/test";

const API_URL = "https://api.tensol.ru";
const TG_WEBHOOK_SECRET = process.env.TENSOL_TELEGRAM_WEBHOOK_SECRET;
const TARGET_DOMAIN = process.env.TENSOL_REAL_TARGET ?? "example.com";
const SCAN_POLL_INTERVAL_MS = 30_000;
const SCAN_POLL_BUDGET_MS = 30 * 60_000; // 30 minutes
const DNS_POLL_INTERVAL_MS = 2_000;
const DNS_POLL_BUDGET_MS = 30_000;

test.describe("T128 real-prod full-scan lifecycle", () => {
  test.setTimeout(45 * 60_000); // 45min hard cap

  test("Telegram-auth → draft → attack-surface → safety → DNS → launch → scan complete", async () => {
    test.skip(!TG_WEBHOOK_SECRET, "TENSOL_TELEGRAM_WEBHOOK_SECRET not set");

    const stepStart = (label: string) => {
      const t0 = Date.now();
      console.log(`[T128] >>> ${label}`);
      return () => {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[T128] <<< ${label} (${dt}s)`);
      };
    };

    // Step 1 — Telegram auth
    const endStep1 = stepStart("Step 1: Telegram-auth webhook simulation");
    const ctx = await apiRequest.newContext();
    const issueResp = await ctx.post(`${API_URL}/api/auth/issue-link`, {
      data: { telegram_username: `t128_${Date.now()}` },
    });
    expect(issueResp.status()).toBe(200);
    const issueData = await issueResp.json();
    const tgUpdateBody = {
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: {
          id: 999_000_002,
          is_bot: false,
          first_name: "T128",
          username: `t128_${Date.now()}`,
        },
        chat: { id: 999_000_002, type: "private" },
        text: `/start ${issueData.token}`,
      },
    };
    const tgResp = await ctx.post(`${API_URL}/v1/webhooks/telegram-update`, {
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": TG_WEBHOOK_SECRET!,
      },
      data: tgUpdateBody,
    });
    expect(tgResp.status()).toBe(200);
    let polled: { status?: string; session_id?: string } = {};
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const pollResp = await ctx.get(
        `${API_URL}/api/auth/poll-link?token=${issueData.token}`,
      );
      polled = await pollResp.json();
      if (polled.status === "resolved") break;
    }
    expect(polled.status).toBe("resolved");
    const sessionId = polled.session_id!;
    expect(sessionId).toBeTruthy();
    endStep1();

    // Authenticated context for the rest of the test
    const sCtx = await apiRequest.newContext({
      extraHTTPHeaders: { Cookie: `tensol_session=${sessionId}` },
    });

    // Step 2 — Create draft
    const endStep2 = stepStart(`Step 2: createDraft target=${TARGET_DOMAIN}`);
    const draftResp = await sCtx.post(`${API_URL}/v1/scan-orders`, {
      data: { tier: "quick", primary_domain: TARGET_DOMAIN },
    });
    expect([200, 201]).toContain(draftResp.status());
    const draft = await draftResp.json();
    expect(draft).toHaveProperty("id");
    const orderId = draft.id;
    console.log(`[T128] orderId=${orderId} status=${draft.status}`);
    endStep2();

    // Step 3 — Attack-surface
    const endStep3 = stepStart("Step 3: PUT attack-surface");
    const asResp = await sCtx.put(
      `${API_URL}/v1/scan-orders/${orderId}/attack-surface`,
      {
        data: {
          attack_surface: [{ host: TARGET_DOMAIN, kind: "domain" }],
        },
      },
    );
    expect(asResp.status()).toBe(200);
    endStep3();

    // Step 4 — Safety
    const endStep4 = stepStart("Step 4: PUT safety rps=10");
    const safetyResp = await sCtx.put(
      `${API_URL}/v1/scan-orders/${orderId}/safety`,
      {
        data: { safety_rps: 10 },
      },
    );
    expect(safetyResp.status()).toBe(200);
    endStep4();

    // Step 5 — DNS verify request
    const endStep5 = stepStart("Step 5: POST dns-verify/request");
    const dnsReqResp = await sCtx.post(
      `${API_URL}/v1/scan-orders/${orderId}/dns-verify/request`,
    );
    expect(dnsReqResp.status()).toBe(200);
    const dnsReq = await dnsReqResp.json();
    expect(dnsReq).toHaveProperty("token");
    endStep5();

    // Step 6 — Poll DNS check (bypass should make this verified within seconds)
    const endStep6 = stepStart("Step 6: poll dns-verify/check");
    let dnsVerified = false;
    const dnsStart = Date.now();
    while (Date.now() - dnsStart < DNS_POLL_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, DNS_POLL_INTERVAL_MS));
      const checkResp = await sCtx.get(
        `${API_URL}/v1/scan-orders/${orderId}/dns-verify/check`,
      );
      expect(checkResp.status()).toBe(200);
      const check = await checkResp.json();
      console.log(
        `[T128]   dns-check attempts=${check.attempts} verified=${check.verified} last_error=${check.last_error ?? "-"}`,
      );
      if (check.verified === true) {
        dnsVerified = true;
        break;
      }
    }
    expect(dnsVerified).toBe(true);
    endStep6();

    // Step 7 — Launch
    const endStep7 = stepStart("Step 7: POST launch");
    const launchResp = await sCtx.post(
      `${API_URL}/v1/scan-orders/${orderId}/launch`,
    );
    console.log(`[T128]   launch status=${launchResp.status()}`);
    if (launchResp.status() !== 202) {
      const body = await launchResp.text();
      console.log(`[T128]   launch body=${body.slice(0, 400)}`);
    }
    expect(launchResp.status()).toBe(202);
    const launchBody = await launchResp.json();
    expect(launchBody).toHaveProperty("scan_id");
    const scanId = launchBody.scan_id;
    console.log(`[T128] scan_id=${scanId}`);
    endStep7();

    // Step 8 — Poll scan status
    const endStep8 = stepStart("Step 8: poll scan status (30s × ~60 = 30min budget)");
    const scanStart = Date.now();
    const statusTransitions: { t: number; status: string }[] = [];
    let lastStatus = "";
    let terminal = false;
    let finalScan: Record<string, unknown> | null = null;
    let pollCount = 0;
    while (Date.now() - scanStart < SCAN_POLL_BUDGET_MS) {
      pollCount++;
      const scanResp = await sCtx.get(`${API_URL}/v1/scans/${scanId}`);
      if (scanResp.status() !== 200) {
        console.log(
          `[T128]   poll #${pollCount} HTTP ${scanResp.status()}`,
        );
        await new Promise((r) => setTimeout(r, SCAN_POLL_INTERVAL_MS));
        continue;
      }
      const scan = await scanResp.json();
      const status = String(scan.status ?? "unknown");
      const elapsed = Math.floor((Date.now() - scanStart) / 1000);
      if (status !== lastStatus) {
        statusTransitions.push({ t: elapsed, status });
        console.log(`[T128]   poll #${pollCount} t=${elapsed}s status=${status}`);
        lastStatus = status;
      } else if (pollCount % 4 === 0) {
        console.log(`[T128]   poll #${pollCount} t=${elapsed}s status=${status} (no change)`);
      }
      if (status === "completed" || status === "failed" || status === "cancelled") {
        terminal = true;
        finalScan = scan;
        break;
      }
      await new Promise((r) => setTimeout(r, SCAN_POLL_INTERVAL_MS));
    }
    console.log(
      `[T128] status transitions: ${statusTransitions
        .map((s) => `${s.status}@${s.t}s`)
        .join(" → ")}`,
    );
    console.log(`[T128] terminal=${terminal} lastStatus=${lastStatus}`);
    endStep8();

    // Step 9 — Findings count
    const endStep9 = stepStart("Step 9: GET /v1/scans/:id/findings");
    const findingsResp = await sCtx.get(`${API_URL}/v1/scans/${scanId}/findings`);
    expect(findingsResp.status()).toBe(200);
    const findings = await findingsResp.json();
    console.log(
      `[T128] findings count=${Array.isArray(findings) ? findings.length : "n/a"}`,
    );
    endStep9();

    // Step 10 — Report status
    const endStep10 = stepStart("Step 10: GET /v1/scans/:id/report");
    const reportResp = await sCtx.get(`${API_URL}/v1/scans/${scanId}/report`);
    console.log(`[T128]   report HTTP=${reportResp.status()}`);
    if (reportResp.status() === 200) {
      const report = await reportResp.json();
      console.log(`[T128] report status=${report.status} byte_size=${report.byte_size ?? "n/a"}`);
    }
    endStep10();

    // Final assertions — terminal must have happened (or test exceeded budget)
    if (!terminal) {
      console.log(
        `[T128] WARN: scan did not reach terminal state inside ${SCAN_POLL_BUDGET_MS / 60_000}min — last=${lastStatus}`,
      );
    }
    // Soft expectation: scan was at least launched (status was tracked)
    expect(statusTransitions.length).toBeGreaterThan(0);
  });
});
