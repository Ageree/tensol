/**
 * T093 — DNS verification 30-min hard-timeout (US1, FR-010).
 *
 * Pre-condition: a `scan_orders` row in `dns_pending` whose
 * `dns_verify_requested_at` is ≥31 minutes in the past. The next
 * `checkVerification` call must:
 *   - return `verified:false`
 *   - flip the order to `failed`
 *   - emit a signed `dns_verify_failed` audit with `reason:"timeout"`
 *     (per `server/src/dns-verify/service.ts` lines 188-211 and
 *      `server/src/dns-verify/service.test.ts`
 *      "checkVerification — 30-min timeout").
 *
 * The wizard's Step 3 surfaces this state as `statusExpired`
 * (`t.wizard.step3.statusExpired`) with a contact-support link
 * (`t.wizard.step3.supportExpired` + `supportContact`).
 *
 * Flow:
 *   1. Seed user + session via /__test/v2/seed-session.
 *   2. Create a `dns_pending` order via /__test/v2/create-dns-pending.
 *   3. Backdate `dns_verify_requested_at` via /__test/v2/expire-dns-verify.
 *   4. Navigate to /scan/new/:orderId/verify (Step 3).
 *   5. Wait for the wizard's poll to trip the timeout — assert the
 *      "Время истекло" / "Verification window expired" copy + the
 *      support-Telegram link.
 *
 * Backend env requirements (T102 must wire):
 *   - Test-only endpoints under /__test/v2/:
 *       POST /__test/v2/seed-session
 *       POST /__test/v2/create-dns-pending
 *       POST /__test/v2/expire-dns-verify
 *
 * Constitution V (NON-NEGOTIABLE): polling assertions only, no SSE.
 * Constitution VII: ≤ 800 LOC.
 *
 * NOTE: this spec is scaffolded so that running it requires the v2
 * test-server (T102 deliverable). Until then, this file documents the
 * full timeout assertions and type-checks cleanly under
 * `@playwright/test`.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import {
  attachSessionCookie,
  BACKEND_BASE_URL,
  createDnsPendingOrder,
  expireDnsVerify,
  FRONTEND_BASE_URL,
  seedSession,
} from './helpers/scan-wizard-helpers.ts';

test.describe('T093 — DNS verify 30-min timeout (US1)', () => {
  // Generous timeout: Step3 polls every 5s; budget two cycles + initial
  // render for slower CI workers.
  test.setTimeout(60_000);

  test('expired dns_verify_requested_at surfaces timeout + contact link', async ({
    page,
    context,
  }) => {
    const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    try {
      // ───────────────────────────────────────────────────────────────
      // 1. Seed user + session.
      // ───────────────────────────────────────────────────────────────
      const seed = await seedSession(
        backend,
        `e2e+dnstimeout+${Date.now()}@example.test`,
      );
      await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

      // ───────────────────────────────────────────────────────────────
      // 2. Create a dns_pending order (skip wizard steps 1 + 2).
      // ───────────────────────────────────────────────────────────────
      const order = await createDnsPendingOrder(
        backend,
        seed.user_id,
        'example.com',
      );
      expect(order.order_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
      expect(order.dns_token.length).toBeGreaterThan(0);

      // ───────────────────────────────────────────────────────────────
      // 3. Backdate `dns_verify_requested_at` so the very next poll
      //    trips the 30-min hard cap.
      // ───────────────────────────────────────────────────────────────
      const expired = await expireDnsVerify(backend, order.order_id);
      expect(expired.ok).toBe(true);
      const cutoffSec = Math.floor(Date.now() / 1000) - 30 * 60;
      // Backdated timestamp must be strictly older than now - 30 min.
      expect(expired.dns_verify_requested_at).toBeLessThan(cutoffSec);

      // ───────────────────────────────────────────────────────────────
      // 4. Navigate to Step 3 (DNS verify).
      // ───────────────────────────────────────────────────────────────
      await page.goto(`/scan/new/${order.order_id}/verify`);

      // The TXT card always renders first regardless of timeout state
      // — the poll then flips the status panel to "expired".
      await expect(
        page.locator('[data-testid="wizard-step3-txt-card"]'),
      ).toBeVisible({ timeout: 15_000 });

      // ───────────────────────────────────────────────────────────────
      // 5. Wait for the timeout copy to appear. Step3DnsVerify renders
      //    either `t.wizard.step3.statusExpired` or the local
      //    `expired` branch when the countdown hits zero. We match
      //    both locales' literal strings from i18n.ts:
      //      EN: "Verification window expired."
      //      RU: "Окно подтверждения истекло."
      // ───────────────────────────────────────────────────────────────
      await expect(page.locator('body')).toContainText(
        /Verification window expired|Окно подтверждения истекло/i,
        { timeout: 30_000 },
      );

      // ───────────────────────────────────────────────────────────────
      // 6. The contact-support Telegram link is conditionally rendered
      //    only when `(stallHint || expired) && !state.dnsVerified`.
      //    Expired === true here, so the link MUST be visible.
      // ───────────────────────────────────────────────────────────────
      const supportLink = page.locator(
        '[data-testid="wizard-step3-support-link"]',
      );
      await expect(supportLink).toBeVisible({ timeout: 10_000 });
      const href = await supportLink.getAttribute('href');
      expect(href ?? '').toMatch(/^https:\/\/t\.me\//);

      // The "Check now" button must be disabled once the window expired
      // (see Step3DnsVerify.tsx: `disabled={expired || state.dnsVerified}`).
      const checkNowBtn = page.locator('button', { hasText: /Check now|Проверить/i });
      await expect(checkNowBtn.first()).toBeDisabled({ timeout: 5_000 });

      // Wizard must stay on the Step 3 URL — we don't auto-advance on
      // a failed verification.
      expect(new URL(page.url()).pathname).toMatch(
        /\/scan\/new\/[0-9A-HJKMNP-TV-Z]{26}\/verify$/i,
      );
    } finally {
      await backend.dispose();
    }
  });
});
