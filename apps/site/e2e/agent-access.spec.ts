import { type Page, expect, test } from "@playwright/test";

async function useEnglish(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.localStorage.setItem("tensol.lang", "en");
	});
}

async function mockAgentAccessApi(
	page: Page,
	tokenStatus = 200,
): Promise<void> {
	await page.route("**/api/auth/me", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				user: { id: "user_1", email: "user@example.com" },
			}),
		}),
	);
	await page.route("**/v1/scan-orders", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
	);
	await page.route("**/v1/agent/tokens", (route) =>
		route.fulfill({
			status: tokenStatus,
			contentType: "application/json",
			body:
				tokenStatus === 200
					? JSON.stringify({
							tokens: [
								{
									id: "tok_1",
									name: "Codex MCP",
									token_prefix: "sthrip_demo_prefix",
									created_at: 1700000000000,
									last_used_at: null,
									revoked_at: null,
								},
							],
						})
					: JSON.stringify({ error: "server_error" }),
		}),
	);
	await page.route("**/v1/config/feature-flags", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				yookassa_live: false,
				research_enabled: true,
				exploit_enabled: true,
			}),
		}),
	);
	await page.route("**/v1/review/repos", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([
				{
					id: "repo_1",
					scm: "github",
					owner: "acme",
					name: "api",
					default_branch: "main",
					status: "active",
					enabled: true,
					covered_branches: [],
					status_check_enabled: true,
					merge_block_on_critical: false,
					last_review_id: null,
					last_review_status: null,
					last_review_score_0_5: null,
					last_review_at: null,
					created_at: 1700000000000,
					updated_at: 1700000000000,
				},
			]),
		}),
	);
	await page.route("**/v1/review/rev_legacy", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				id: "rev_legacy",
				repo: "legacy/api",
				repo_id: "repo_legacy",
				kind: "pr",
				pr_number: 7,
				head_sha: null,
				status: "completed",
				score_0_5: 3,
				summary_md: "Legacy summary",
				findings_count: 0,
				error: null,
				created_at: 1700000000000,
				completed_at: 1700000001000,
				findings: [],
			}),
		}),
	);
	await page.route("**/v1/review", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify([
				{
					review_id: "rev_1",
					kind: "whitebox",
					mode: "deep",
					status: "completed",
					score_0_5: 4,
					pr_number: null,
					repo: "acme/api",
					created_at: 1700000000000,
					completed_at: 1700000001000,
					findings_count: 0,
				},
				{
					review_id: "rev_legacy",
					kind: "pr",
					status: "completed",
					score_0_5: 3,
					pr_number: 7,
					repo: "legacy/api",
					created_at: 1700000000000,
					completed_at: 1700000001000,
					findings_count: 1,
				},
			]),
		}),
	);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		)
		.toBe(true);
}

test("settings keeps account visible when agent tokens fail and labels token input", async ({
	page,
}) => {
	await useEnglish(page);
	await mockAgentAccessApi(page, 500);

	await page.goto("/settings", { waitUntil: "domcontentloaded" });

	await expect(page.getByText("user@example.com")).toBeVisible();
	await expect(page.getByText("Failed to load agent tokens")).toBeVisible();
	await expect(page.getByLabel("token name")).toBeVisible();
	await expectNoPageOverflow(page);
});

test("reviews list does not coerce missing mode to fast", async ({ page }) => {
	await useEnglish(page);
	await mockAgentAccessApi(page);

	await page.goto("/reviews", { waitUntil: "domcontentloaded" });

	await expect(page.getByText("Mode")).toBeVisible();
	await expect(page.getByRole("row", { name: /acme\/api/ })).toContainText(
		"deep",
	);
	await expect(
		page.getByRole("row", { name: /legacy\/api/ }),
	).not.toContainText("fast");
	await expectNoPageOverflow(page);
});

test("review detail hides absent mode instead of rendering fast", async ({
	page,
}) => {
	await useEnglish(page);
	await mockAgentAccessApi(page);

	await page.goto("/reviews/rev_legacy", { waitUntil: "domcontentloaded" });

	await expect(page.getByText("legacy/api #7")).toBeVisible();
	await expect(page.locator("header")).not.toContainText("fast");
	await expectNoPageOverflow(page);
});
