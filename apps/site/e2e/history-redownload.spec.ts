/**
 * T120 — History re-download flow (US3, FR-018 + FR-020).
 *
 * Pre-condition: a fixture user already has one completed scan in their
 * history (scan_order in `completed`, sibling `scans` row in `completed`,
 * a non-zero `findings` set, and a `reports` row in `ready` with a
 * stubbed signed download URL).
 *
 * Expectation: the dashboard surfaces that scan as a clickable row, the
 * row's action button routes the user to the report page where the
 * "Download PDF" CTA is visible. After the report's `download_expires_at`
 * is flipped to the past (and its status to `failed` so the regen
 * affordance lights up — see helper docs), reloading the report page
 * surfaces the "Regenerate" button.
 *
 * Flow:
 *   1. Seed user + session via /__test/v2/seed-session.
 *   2. Seed a completed scan history row via
 *      /__test/v2/seed-completed-scan (9 findings, report=ready).
 *   3. Navigate to /dashboard — assert the row is visible (primary_domain
 *      cell + Download action CTA both present).
 *   4. Click the row's Action CTA → routes to /scan/:scan_id/report.
 *   5. Assert "Download PDF" CTA visible + status chip = "ready".
 *   6. Sidebar nav to /scan/:scan_id/findings — assert findings render.
 *   7. Backdate report.expires_at via /__test/v2/expire-report.
 *   8. Reload /scan/:scan_id/report — assert "Regenerate" button visible.
 *
 * Backend env requirements (T102 must wire):
 *   - Test-only endpoints under /__test/v2/:
 *       POST /__test/v2/seed-session
 *       POST /__test/v2/seed-completed-scan
 *       POST /__test/v2/expire-report
 *
 * Constitution V (NON-NEGOTIABLE): polling assertions only, no SSE.
 * Constitution VII: ≤ 800 LOC.
 *
 * NOTE: this spec is scaffolded so that running it requires the v2
 * test-server (T102 deliverable). Until then, this file documents the
 * full history + re-download + regenerate-on-expiry assertions and
 * type-checks cleanly under `@playwright/test`.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import {
  attachSessionCookie,
  BACKEND_BASE_URL,
  expireReport,
  FRONTEND_BASE_URL,
  seedCompletedScan,
  seedSession,
} from './helpers/scan-wizard-helpers.ts';

test.describe('T120 — history re-download (US3)', () => {
  // Budget: dashboard list fetch + two report-page polls (5s each) +
  // navigation overhead. Generous for slow CI workers.
  test.setTimeout(60_000);

  test('completed scan in dashboard → report download → expire → regenerate', async ({
    page,
    context,
  }) => {
    const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    try {
      // ─────────────────────────────────────────────────────────────────
      // 1. Seed user + session, drop the cookie into the browser.
      // ─────────────────────────────────────────────────────────────────
      const seed = await seedSession(
        backend,
        `e2e+history+${Date.now()}@example.test`,
      );
      await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

      // ─────────────────────────────────────────────────────────────────
      // 2. Seed a completed scan history row (default 9 findings,
      //    report=ready). The fixture user now has a single row of
      //    history visible on /dashboard.
      // ─────────────────────────────────────────────────────────────────
      const history = await seedCompletedScan(backend, {
        userId: seed.user_id,
        primaryDomain: 'history.example.com',
        findingsCount: 9,
        reportStatus: 'ready',
      });
      expect(history.order_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
      expect(history.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
      expect(history.report_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

      // ─────────────────────────────────────────────────────────────────
      // 3. Visit /dashboard — assert the seeded row is present.
      //    Dashboard.tsx renders a `data-testid="dashboard-scans-table"`
      //    section that holds all ScanRow children; we assert both the
      //    domain cell and the row's Download CTA are visible.
      // ─────────────────────────────────────────────────────────────────
      await page.goto('/dashboard');
      const scansTable = page.locator(
        '[data-testid="dashboard-scans-table"]',
      );
      await expect(scansTable).toBeVisible({ timeout: 15_000 });
      await expect(scansTable).toContainText('history.example.com', {
        timeout: 10_000,
      });

      // Empty-state should NOT render when at least one row exists.
      await expect(
        page.locator('[data-testid="dashboard-empty-state"]'),
      ).toHaveCount(0);

      // The action CTA for a `completed` order maps to the "Download PDF"
      // label routed to /scan/:scan_id/report (per dashboard-helpers
      // `mapStatusToAction` → key='download', route='report').
      const reportHref = `/scan/${history.scan_id}/report`;
      const reportRowLink = scansTable.locator(`a[href="${reportHref}"]`);
      await expect(reportRowLink).toBeVisible({ timeout: 10_000 });
      await expect(reportRowLink).toContainText(/Download PDF|Скачать PDF/i);

      // ─────────────────────────────────────────────────────────────────
      // 4. Click the row's CTA → /scan/:scan_id/report.
      // ─────────────────────────────────────────────────────────────────
      await reportRowLink.click();
      await page.waitForURL(
        new RegExp(`/scan/${history.scan_id}/report$`, 'i'),
        { timeout: 10_000 },
      );

      // ─────────────────────────────────────────────────────────────────
      // 5. Report page — status=ready + Download CTA visible.
      //    Reports.tsx renders the StatusChip + Btn["Download PDF"]
      //    only when status='ready' (or "Regenerate" on 'failed').
      // ─────────────────────────────────────────────────────────────────
      await expect(page.locator('body')).toContainText(/ready|готов/i, {
        timeout: 15_000,
      });
      const downloadCta = page
        .locator(
          'a:has-text("Download PDF"), a:has-text("Скачать PDF")',
        )
        .first();
      await expect(downloadCta).toBeVisible({ timeout: 10_000 });

      // The download anchor must point at the signed URL the seed
      // helper populated. We don't fetch it (Playwright would 404 on a
      // stub URL), but we assert it's a non-empty href.
      const downloadHref = await downloadCta.getAttribute('href');
      expect(downloadHref).toBeTruthy();

      // ─────────────────────────────────────────────────────────────────
      // 6. Findings page — assert the 9 seeded findings render.
      //    From the report page we navigate directly to the findings
      //    sibling route rather than relying on a back-link.
      // ─────────────────────────────────────────────────────────────────
      await page.goto(`/scan/${history.scan_id}/findings`);
      await page.waitForURL(
        new RegExp(`/scan/${history.scan_id}/findings$`, 'i'),
        { timeout: 10_000 },
      );
      await expect(page.locator('body')).toContainText(/9/, {
        timeout: 15_000,
      });

      // ─────────────────────────────────────────────────────────────────
      // 7. Backdate `reports.download_expires_at` and flip status to
      //    'failed' so the regenerate affordance lights up on reload.
      // ─────────────────────────────────────────────────────────────────
      const expireResult = await expireReport(backend, history.report_id);
      expect(expireResult.ok).toBe(true);
      expect(expireResult.expires_at).toBeLessThan(Date.now());

      // ─────────────────────────────────────────────────────────────────
      // 8. Reload report page — assert "Regenerate" button is visible.
      //    Reports.tsx only renders the Regenerate <Btn> on status
      //    'failed' (matches mapStatusToAction's regenerate key for
      //    failed orders). The Download CTA must no longer be visible.
      // ─────────────────────────────────────────────────────────────────
      await page.goto(`/scan/${history.scan_id}/report`);
      await page.waitForURL(
        new RegExp(`/scan/${history.scan_id}/report$`, 'i'),
        { timeout: 10_000 },
      );

      const regenerateBtn = page
        .locator(
          'button:has-text("Regenerate"), button:has-text("Перегенерировать")',
        )
        .first();
      await expect(regenerateBtn).toBeVisible({ timeout: 15_000 });

      // Download CTA is gone on `failed`.
      await expect(
        page.locator(
          'a:has-text("Download PDF"), a:has-text("Скачать PDF")',
        ),
      ).toHaveCount(0);

      // Status chip flipped to "failed".
      await expect(page.locator('body')).toContainText(/failed|ошибка/i, {
        timeout: 10_000,
      });
    } finally {
      await backend.dispose();
    }
  });
});
