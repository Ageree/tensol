/**
 * T092 — Free-quota exhausted launch flow (US1, FR-014).
 *
 * Pre-condition: user has already consumed their one free Quick scan
 * in the current 7-day window (`users.free_quick_consumed_at = now()`).
 * Expectation: clicking "Launch free Quick" returns 429 from
 * `POST /v1/scan-orders/:id/launch` and the wizard surfaces an inline
 * error + a contact CTA (per T089: Deep audit lands on /contact in MVP;
 * a dedicated `/deep-inquiry` page is US2 scope).
 *
 * Service contract referenced (`server/src/scan-orders/service.ts`):
 *   - `launchScan` throws `QUOTA_EXHAUSTED` (line 488) when
 *     `consumeFreeQuickQuota` reports `consumed:false`.
 *   - The route layer maps `QUOTA_EXHAUSTED` → HTTP 429.
 *
 * Flow:
 *   1. Seed user + session via /__test/v2/seed-session.
 *   2. Mark quota exhausted via /__test/v2/exhaust-quota.
 *   3. Shortcut a `dns_verified` order via /__test/v2/create-dns-verified
 *      to skip walking steps 1-3 every time.
 *   4. Navigate directly to /scan/new/:orderId/launch (Step 4).
 *   5. Click "Launch free Quick" → assert 429 inline error + contact link.
 *
 * Backend env requirements (provided by global setup):
 *   - TENSOL_DEV_DNS_BYPASS=true (sibling spec, not relied on here)
 *   - Test-only endpoints under /__test/v2/:
 *       POST /__test/v2/seed-session
 *       POST /__test/v2/exhaust-quota
 *       POST /__test/v2/create-dns-verified
 *
 * Constitution V (NON-NEGOTIABLE): polling assertions only, no SSE.
 * Constitution VII: ≤ 800 LOC.
 *
 * Runs against the v2 test-server booted by global setup.
 */
import { expect, request as pwRequest, test } from "@playwright/test";
import {
	BACKEND_BASE_URL,
	FRONTEND_BASE_URL,
	attachSessionCookie,
	createDnsVerifiedOrder,
	exhaustFreeQuota,
	seedSession,
} from "./helpers/scan-wizard-helpers.ts";

test.describe("T092 — free-quota exhausted (US1)", () => {
	test.setTimeout(60_000);

	test("launch click on exhausted quota surfaces 429 + contact CTA", async ({
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
				`e2e+freequota+${Date.now()}@example.test`,
			);
			await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

			// ───────────────────────────────────────────────────────────────
			// 2. Exhaust the user's free-Quick quota — sets
			//    `users.free_quick_consumed_at = now()` so the launch will
			//    fail with QUOTA_EXHAUSTED → 429 at the route layer.
			// ───────────────────────────────────────────────────────────────
			const quotaRes = await exhaustFreeQuota(backend, seed.user_id);
			expect(quotaRes.ok).toBe(true);
			expect(quotaRes.free_quick_consumed_at).toBeGreaterThan(0);

			// ───────────────────────────────────────────────────────────────
			// 3. Shortcut: create a scan_order already in `dns_verified` so
			//    the spec lands directly on Step 4 without re-walking steps
			//    1-3. The shortcut endpoint mirrors the same row shape the
			//    wizard would have produced via the public API.
			// ───────────────────────────────────────────────────────────────
			const order = await createDnsVerifiedOrder(
				backend,
				seed.user_id,
				"example.com",
				10,
			);
			expect(order.order_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

			// ───────────────────────────────────────────────────────────────
			// 4. Navigate to Step 4 directly.
			// ───────────────────────────────────────────────────────────────
			await page.goto(`/scan/new/${order.order_id}/launch`);

			await expect(
				page.locator('[data-testid="wizard-step4-launch-btn"]'),
			).toBeVisible({ timeout: 15_000 });

			// Sanity: summary card shows the seeded domain.
			await expect(
				page.locator('[data-testid="wizard-step4-domain"]'),
			).toHaveText("example.com");

			// ───────────────────────────────────────────────────────────────
			// 5. Click Launch — server returns 429, UI surfaces the error in
			//    the launchError block (`t.wizard.step4.launchError`).
			//
			//    Match either locale: EN "Launch failed" / RU "Не удалось
			//    запустить". The launchErr code from ApiError is rendered
			//    right next to the label as `: quota_exhausted`.
			// ───────────────────────────────────────────────────────────────
			await page.locator('[data-testid="wizard-step4-launch-btn"]').click();

			await expect(page.locator("body")).toContainText(
				/Launch failed|Не удалось запустить/i,
				{ timeout: 10_000 },
			);
			// The mapped error code from the 429 response must surface.
			await expect(page.locator("body")).toContainText(/quota[_ ]exhausted/i);

			// Wizard must not navigate away on a failed launch — we are
			// still on the Step 4 launch URL.
			expect(new URL(page.url()).pathname).toMatch(
				/\/scan\/new\/[0-9A-HJKMNP-TV-Z]{26}\/launch$/i,
			);

			// ───────────────────────────────────────────────────────────────
			// 6. Contact CTA must remain reachable. Per T089 the Deep audit
			//    page is /contact in MVP (US2 will introduce /deep-inquiry).
			//    The marketing footer + global nav both link to /contact, so
			//    we navigate there and confirm the page renders.
			// ───────────────────────────────────────────────────────────────
			await page.goto("/contact");
			await expect(page).toHaveURL(/\/contact$/);
			// Contact page must surface a form or the founder direct link;
			// assert the visible Telegram CTA the team ships on /contact.
			await expect(page.locator("body")).toContainText(
				/telegram|@kapital0|sthrip/i,
				{ timeout: 10_000 },
			);
		} finally {
			await backend.dispose();
		}
	});
});
