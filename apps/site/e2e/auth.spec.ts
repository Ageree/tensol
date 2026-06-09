import { expect, test } from "@playwright/test";
import { attachConsoleAssertions } from "./helpers/console.ts";

test.describe("/login", () => {
	test("renders Clerk fallback without provider crash", async ({ page }) => {
		const console$ = attachConsoleAssertions(page);
		await page.goto("/login");
		await page.waitForLoadState("networkidle");

		await expect(page.locator("body")).toContainText("Log in to Sthrip.");
		await expect(page.locator("body")).toContainText("auth_not_configured");

		console$.assertClean();
	});

	test("auth error code is surfaced", async ({ page }) => {
		const console$ = attachConsoleAssertions(page);
		await page.goto("/login?error=unauthenticated");
		await page.waitForLoadState("networkidle");

		await expect(page.locator("body")).toContainText("sign_in_required");

		console$.assertClean();
	});
});

test.describe("/signup", () => {
	test("renders Clerk fallback without provider crash", async ({ page }) => {
		const console$ = attachConsoleAssertions(page);
		await page.goto("/signup");
		await page.waitForLoadState("networkidle");

		await expect(page.locator("body")).toContainText(
			"Create your Sthrip account.",
		);
		await expect(page.locator("body")).toContainText("auth_not_configured");

		console$.assertClean();
	});
});

test.describe("/bootstrap", () => {
	test("renders without crash", async ({ page }) => {
		const console$ = attachConsoleAssertions(page);
		await page.goto("/bootstrap");
		await page.waitForLoadState("networkidle");
		await expect(page.locator("body")).toBeVisible();
		console$.assertClean();
	});
});

test.describe("/invite", () => {
	test("renders without crash", async ({ page }) => {
		const console$ = attachConsoleAssertions(page);
		await page.goto("/invite");
		await page.waitForLoadState("networkidle");
		await expect(page.locator("body")).toBeVisible();
		console$.assertClean();
	});
});
