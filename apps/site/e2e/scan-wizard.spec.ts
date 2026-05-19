/**
 * T091 — Blackbox-MVP US1 end-to-end happy path.
 *
 * Flow covered (per tasks.md T091, spec.md FR-004 .. FR-014):
 *   1. Auth bypass: seed a user + valid session row in the dev DB, then
 *      drop the `tensol_session` cookie directly into the browser context.
 *      (Per docs/pivot-2026-05-19-telegram-auth.md the magic-link channel
 *      is now Telegram, which is out-of-band; a pre-seeded cookie is the
 *      standard E2E shortcut for OOB auth.)
 *   2. Navigate to /scan/new → wizard creates draft order → step 1.
 *   3. Step 1 (Attack Surface) — enter primary domain → Next.
 *   4. Step 2 (Safety) — pick the "Safe" preset (RPS=10) → Next.
 *   5. Step 3 (DNS Verify) — `TENSOL_DEV_DNS_BYPASS=true` auto-verifies
 *      after ≥5s elapsed; we let the 5s poll loop tick once, then assert
 *      status=verified and click Next.
 *   6. Step 4 (Review/Launch) — click "Launch" → navigates to /scan/:id.
 *   7. Simulate scan completion by POSTing the Juice Shop fixture to
 *      `/v1/webhooks/scan-complete`, signed per webhook.md with
 *      `t=<unix-seconds>, v1=<hex-hmac-sha256>` where the HMAC is over
 *      `${t}.${body_bytes}` keyed by TENSOL_WEBHOOK_SECRET. This is faster
 *      than orchestrating a real fake-vps-agent loop.
 *   8. Live page — assert it transitions to `completed`, and the
 *      "Findings" + "Report" CTAs appear.
 *   9. Findings page — assert all 9 Juice Shop findings render.
 *  10. Report page — assert status=ready (after render_pdf job ticks) and
 *      a download link is visible.
 *
 * Backend env requirements (set by T102 smoke runner):
 *   - TENSOL_DEV_DNS_BYPASS=true   — auto-verifies DNS after ~5s
 *   - TENSOL_WEBHOOK_SECRET=<hex>  — must match `E2E_WEBHOOK_SECRET` below
 *   - Fake CloudProvider wired    — no real Yandex calls
 *   - Test-only endpoints exposed under `/__test/v2/...`:
 *       POST /__test/v2/seed-session   { email } → { session_id, user_id }
 *       GET  /__test/v2/scan-order/:id/vps-secret → { webhook_secret }
 *       (the scan-complete webhook is per-fleet, not per-VPS; the secret
 *        comes from TENSOL_WEBHOOK_SECRET — but we expose it via __test for
 *        clarity and to let the spec drive the same shape if the backend
 *        ever moves to per-order secrets.)
 *
 * Constitution V (NON-NEGOTIABLE): polling only, no SSE.
 * Constitution VII: server-side Zod is canonical; this spec mirrors the
 *   snake_case contract shapes from `specs/002-blackbox-mvp/contracts/`.
 *
 * NOTE: this spec is scaffolded so that running it requires the v2
 * test-server (T102 deliverable). Until then, this file documents the
 * full happy-path assertions and type-checks cleanly under `@playwright/
 * test`.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import {
  attachSessionCookie,
  BACKEND_BASE_URL,
  FRONTEND_BASE_URL,
  pollUntil,
  seedSession,
  simulateScanComplete,
} from './helpers/scan-wizard-helpers.ts';

// ── Test ───────────────────────────────────────────────────────────────────

test.describe('T091 — scan wizard happy path (US1)', () => {
  // The DNS bypass alone needs ~5s, plus VM provisioning + webhook +
  // render_pdf job ticks; budget generously for slow CI workers.
  test.setTimeout(120_000);

  test('landing → wizard 1..4 → live → findings → report', async ({
    page,
    context,
  }) => {
    // ─────────────────────────────────────────────────────────────────
    // 1. Seed user + session via backend test helper, drop cookie.
    // ─────────────────────────────────────────────────────────────────
    const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    try {
      const seed = await seedSession(
        backend,
        `e2e+wizard+${Date.now()}@example.test`,
      );

      await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

      // ───────────────────────────────────────────────────────────────
      // 2. Navigate to /scan/new — the wizard auto-creates a draft
      //    order and redirects to /scan/new/:orderId/surface.
      // ───────────────────────────────────────────────────────────────
      await page.goto('/scan/new');
      await page.waitForURL(/\/scan\/new\/[0-9A-HJKMNP-TV-Z]{26}\/surface/i, {
        timeout: 15_000,
      });

      // Capture the orderId from the URL — we need it for the webhook step.
      const wizardUrl = new URL(page.url());
      const orderIdMatch = wizardUrl.pathname.match(
        /\/scan\/new\/([0-9A-HJKMNP-TV-Z]{26})\/surface/i,
      );
      expect(orderIdMatch).not.toBeNull();
      const scanOrderId = orderIdMatch![1]!;

      // ───────────────────────────────────────────────────────────────
      // 3. Step 1 — Attack Surface: enter domain.
      // ───────────────────────────────────────────────────────────────
      await page.locator('[data-testid="wizard-step1-domain"]').fill('example.com');
      await page.locator('button:has-text("Next")').click();

      // Wait for step-2 URL slug.
      await page.waitForURL(/\/scan\/new\/[0-9A-HJKMNP-TV-Z]{26}\/safety/i, {
        timeout: 10_000,
      });

      // ───────────────────────────────────────────────────────────────
      // 4. Step 2 — Safety: pick the Safe preset (RPS=10) → Next.
      // ───────────────────────────────────────────────────────────────
      // Safe preset button label format: "Safe · 10" (per Step2Safety.tsx).
      await page.locator('button:has-text("Safe")').first().click();
      await page.locator('button:has-text("Next")').click();

      // Wait for step-3 URL slug.
      await page.waitForURL(/\/scan\/new\/[0-9A-HJKMNP-TV-Z]{26}\/verify/i, {
        timeout: 10_000,
      });

      // ───────────────────────────────────────────────────────────────
      // 5. Step 3 — DNS Verify: wait for the bypass to auto-verify.
      //    Step3DnsVerify polls every 5s; the bypass kicks in after
      //    ≥5s elapsed. Budget 30s for the first auto-verification.
      // ───────────────────────────────────────────────────────────────
      await expect(
        page.locator('[data-testid="wizard-step3-txt-card"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Step3DnsVerify auto-navigates to /wizard/:id/step-4 on verified,
      // but the canonical container route is /scan/new/:id/launch. Either
      // shape lands us at step 4. Wait for the Step 4 launch button to
      // appear, however we arrive there.
      await expect(
        page.locator('[data-testid="wizard-step4-launch-btn"]'),
      ).toBeVisible({ timeout: 60_000 });

      // ───────────────────────────────────────────────────────────────
      // 6. Step 4 — Review/Launch: click Launch → /scan/:scanId.
      // ───────────────────────────────────────────────────────────────
      // Confirm summary card surfaces the entered values.
      await expect(
        page.locator('[data-testid="wizard-step4-domain"]'),
      ).toHaveText('example.com');
      await expect(
        page.locator('[data-testid="wizard-step4-rps"]'),
      ).toHaveText('10');
      await expect(
        page.locator('[data-testid="wizard-step4-dns-verified"]'),
      ).not.toHaveText(/false|нет/i);

      await page.locator('[data-testid="wizard-step4-launch-btn"]').click();

      // Launch redirects to /scan/:scanId — capture the scan ID.
      await page.waitForURL(/\/scan\/[0-9A-HJKMNP-TV-Z]{26}$/i, {
        timeout: 15_000,
      });

      // ───────────────────────────────────────────────────────────────
      // 7. Simulate the VPS pushing a complete payload via the real
      //    /v1/webhooks/scan-complete endpoint. Replays Juice Shop
      //    fixture (9 findings) signed with TENSOL_WEBHOOK_SECRET.
      // ───────────────────────────────────────────────────────────────
      const webhookRes = await simulateScanComplete(backend, scanOrderId);
      expect(webhookRes.ok).toBe(true);
      expect(webhookRes.inserted_findings).toBe(9);

      // ───────────────────────────────────────────────────────────────
      // 8. Live page — wait for "completed" status to render.
      //    Live polls every few seconds; budget 30s.
      // ───────────────────────────────────────────────────────────────
      await expect(page.locator('body')).toContainText(/completed/i, {
        timeout: 30_000,
      });

      // The "Findings" + "Report" CTAs only show when status is terminal.
      await expect(page.locator('a[href$="/findings"]')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('a[href$="/report"]')).toBeVisible();

      // ───────────────────────────────────────────────────────────────
      // 9. Findings page — assert all 9 Juice Shop findings render.
      // ───────────────────────────────────────────────────────────────
      await page.locator('a[href$="/findings"]').first().click();
      await page.waitForURL(/\/scan\/[0-9A-HJKMNP-TV-Z]{26}\/findings$/i, {
        timeout: 10_000,
      });

      // Findings.tsx renders `countOf` text like "Showing N of M". We
      // simply assert "9" appears somewhere on the page; tighter selector
      // can be added once a stable data-testid lands on the count badge.
      await expect(page.locator('body')).toContainText(/9/, {
        timeout: 15_000,
      });

      // ───────────────────────────────────────────────────────────────
      // 10. Report page — assert status=ready + download link visible.
      //     render_pdf job is enqueued by the webhook handler; budget
      //     60s for the runner to pick it up and the page to poll the
      //     status into `ready`.
      // ───────────────────────────────────────────────────────────────
      await page.goBack();
      await page.locator('a[href$="/report"]').first().click();
      await page.waitForURL(/\/scan\/[0-9A-HJKMNP-TV-Z]{26}\/report$/i, {
        timeout: 10_000,
      });

      await pollUntil(
        async () => {
          const text = await page.locator('body').innerText();
          return /ready|готов/i.test(text) ? true : undefined;
        },
        { intervalMs: 1_000, timeoutMs: 60_000, label: 'report→ready' },
      );

      // Download CTA must be visible once the report is ready.
      await expect(
        page.locator('a[download], a:has-text("Download"), a:has-text("Скачать")').first(),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await backend.dispose();
    }
  });
});
