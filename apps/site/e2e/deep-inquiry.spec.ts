/**
 * T112 — Deep-inquiry (US2) end-to-end specs.
 *
 * Two scenarios exercise the public `POST /v1/deep-inquiries` funnel:
 *
 *   1. Anonymous submit (no session cookie). Walks the 9-field form (skipping
 *      the two optional fields per the brief: `email` and `desired_date`),
 *      submits, and asserts the navigation to /deep-inquiry/thank-you and
 *      the success heading renders.
 *
 *   2. Signed-in prefill. Pre-seeds a user + session via the same
 *      `__test/v2/seed-session` helper used by T091, drops the
 *      `tensol_session` cookie, opens /deep-inquiry, and asserts the
 *      `contact_email` input is pre-populated with the seeded address
 *      (per DeepInquiry.tsx's `useEffect(() => auth.me())` block).
 *
 * Wire contract (server canonical): server/src/schemas/deep-inquiries.ts
 * + specs/002-blackbox-mvp/contracts/openapi.yaml. Constitution VII: client
 * mirrors snake_case shape only as a UX hint, server-side Zod is the source
 * of truth.
 *
 * Constitution V (NON-NEGOTIABLE): polling only, no SSE — N/A here, but
 * helpers reuse the same auth-bypass primitive as the scan-wizard specs.
 *
 * Runtime: Playwright global setup starts the local v2 test-server, which
 * exposes:
 *   - POST /__test/v2/seed-session      { email } → { session_id, user_id }
 *   - POST /v1/deep-inquiries           (the real production endpoint)
 *   - GET  /api/auth/me                 (the real production endpoint)
 */
import { expect, request as pwRequest, test } from "@playwright/test";
import {
	BACKEND_BASE_URL,
	FRONTEND_BASE_URL,
	attachSessionCookie,
	seedSession,
} from "./helpers/scan-wizard-helpers.ts";

// ── Form filler ────────────────────────────────────────────────────────────

interface DeepInquiryFormInput {
	readonly company: string;
	readonly contact_name: string;
	readonly position?: string;
	readonly email?: string;
	readonly phone: string;
	readonly domains_text: string;
	readonly scope_text: string;
	readonly budget_band?:
		| ""
		| "open"
		| "under_500k"
		| "500k_1m"
		| "1m_3m"
		| "3m_plus";
}

/**
 * Fill the deep-inquiry form. The page renders Field labels via i18n, so
 * we drive each input by its semantic shape (autocomplete attr or
 * surrounding label text) instead of brittle label-string matches.
 *
 * Field order matches DeepInquiry.tsx top-to-bottom.
 */
async function fillDeepInquiryForm(
	page: import("@playwright/test").Page,
	input: DeepInquiryFormInput,
): Promise<void> {
	// Company — autocomplete="organization".
	await page.locator('input[autocomplete="organization"]').fill(input.company);

	// Contact name — autocomplete="name".
	await page.locator('input[autocomplete="name"]').fill(input.contact_name);

	// Position — autocomplete="organization-title" (optional).
	if (input.position !== undefined) {
		await page
			.locator('input[autocomplete="organization-title"]')
			.fill(input.position);
	}

	// Email — type="email" + autocomplete="email" (optional). When omitted,
	// we explicitly clear so this helper is composable across the anon/auth
	// variants (the signed-in scenario seeds it from the session).
	if (input.email !== undefined) {
		await page.locator('input[autocomplete="email"]').fill(input.email);
	}

	// Phone / Telegram — autocomplete="tel".
	await page.locator('input[autocomplete="tel"]').fill(input.phone);

	// Domains text + scope text — the two textareas, in order.
	await page.locator("textarea").nth(0).fill(input.domains_text);
	await page.locator("textarea").nth(1).fill(input.scope_text);

	// Budget band — native <select> rendered by primitives.Select.
	if (input.budget_band !== undefined && input.budget_band !== "") {
		await page.locator("select").selectOption(input.budget_band);
	}

	// Consent checkbox (always required by server Zod). The design-system
	// checkbox hides the native input, so click its visible label wrapper.
	await page
		.locator("label")
		.filter({ hasText: "I agree Sthrip may use my details" })
		.click();
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe("T112 — deep-inquiry (US2 lead-gen funnel)", () => {
	test.setTimeout(30_000);

	test("anonymous submit → /deep-inquiry/thank-you", async ({ page }) => {
		await page.goto("/deep-inquiry");
		await page.waitForLoadState("networkidle");

		// Confirm the form rendered (data-screen-label="deep-inquiry").
		await expect(
			page.locator('form[data-screen-label="deep-inquiry"]'),
		).toBeVisible({ timeout: 10_000 });

		await fillDeepInquiryForm(page, {
			company: "Acme Corp E2E",
			contact_name: "Alex Karpov",
			position: "CISO",
			// email omitted — anonymous flow exercises the no-email branch.
			phone: "+7 999 123-45-67",
			domains_text: "acme.test\napi.acme.test",
			scope_text:
				"External perimeter only. No DoS, no destructive payloads, no /admin/* during business hours.",
			budget_band: "500k_1m",
			// desired_date omitted per brief — exercises the optional-date branch.
		});

		// Submit → server returns 201, client navigates to thank-you.
		await page.locator('button[type="submit"]').click();

		await page.waitForURL(/\/deep-inquiry\/thank-you$/i, {
			timeout: 15_000,
		});

		// Success page asserts: heading text + return-home CTA.
		// DeepInquiryThankYou.tsx renders the title in <h1>; we match the
		// i18n key by role+level to avoid coupling to RU/EN string contents.
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
			timeout: 5_000,
		});

		// The "STATUS · RECEIVED" mono-eyebrow is locale-independent.
		await expect(page.locator("body")).toContainText(/RECEIVED/i, {
			timeout: 5_000,
		});
	});

	test("signed-in pre-fills contact_email from session", async ({
		page,
		context,
	}) => {
		const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
		try {
			const sessionEmail = `e2e+deep+${Date.now()}@example.test`;
			const seed = await seedSession(backend, sessionEmail);

			await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

			await page.goto("/deep-inquiry");
			await page.waitForLoadState("networkidle");

			// DeepInquiry.tsx fires `auth.me()` in useEffect; poll the email
			// input until the prefill arrives (loose timeout — local fetch is
			// sub-second but CI workers can be slow).
			const emailInput = page.locator('input[autocomplete="email"]');
			await expect(emailInput).toHaveValue(sessionEmail, { timeout: 10_000 });

			// Fill the remaining required fields and submit; the prefill must
			// survive the round-trip into the success page.
			await fillDeepInquiryForm(page, {
				company: "Authed Acme E2E",
				contact_name: "Mara Stone",
				position: "Head of Security",
				// email left as-is — pre-filled by /api/auth/me.
				phone: "@maratest",
				domains_text: "authed.acme.test",
				scope_text:
					"External perimeter, no destructive payloads, exclude /admin during business hours.",
				budget_band: "1m_3m",
			});

			await page.locator('button[type="submit"]').click();

			await page.waitForURL(/\/deep-inquiry\/thank-you$/i, {
				timeout: 15_000,
			});
			await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
				timeout: 5_000,
			});
		} finally {
			await backend.dispose();
		}
	});
});
