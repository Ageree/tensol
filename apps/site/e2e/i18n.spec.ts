import { expect, test } from "@playwright/test";
import { KNOWN_NATURAL_WORDS } from "./fixtures/i18n-allowlist.ts";
import { escapeRegex, i18nKeys } from "./fixtures/i18n-keys.ts";

// Route hubs keep TensolProvider mounted while the target page loads.
const HUB_MARKETING = "/";
const HUB_APP = "/dashboard";
const HUB_AUTH = "/login";

function hubFor(route: string): string {
	if (
		route.startsWith("/dashboard") ||
		route.startsWith("/projects") ||
		route.startsWith("/targets") ||
		route.startsWith("/builder") ||
		route.startsWith("/approval") ||
		route.startsWith("/live") ||
		route.startsWith("/findings") ||
		route.startsWith("/reports") ||
		route.startsWith("/settings")
	) {
		return HUB_APP;
	}
	if (
		route.startsWith("/login") ||
		route.startsWith("/bootstrap") ||
		route.startsWith("/invite")
	) {
		return HUB_AUTH;
	}
	return HUB_MARKETING;
}

// All 17 real routes (no catchall)
const ALL_ROUTES = [
	"/",
	"/pricing",
	"/trust",
	"/contact",
	"/legal/privacy",
	"/legal/terms",
	"/legal/refund",
	"/legal/dpa",
	"/login",
	"/bootstrap",
	"/invite",
	"/dashboard",
	"/projects",
	"/targets",
	"/builder",
	"/approval",
	"/live",
	"/findings",
	"/reports",
	"/settings",
	"/err/401",
	"/err/403",
	"/err/404",
	"/err/500",
	"/err/offline",
] as const;

async function assertNoKeyLeaks(
	page: import("@playwright/test").Page,
): Promise<void> {
	const bodyText = await page.locator("body").innerText();
	const leaks: string[] = [];
	for (const key of i18nKeys) {
		if (typeof key !== "string" || key.length < 3) continue;
		// Skip keys that are known natural words appearing as real rendered content.
		if (KNOWN_NATURAL_WORDS.has(key)) continue;
		const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
		if (re.test(bodyText)) {
			leaks.push(key);
		}
	}
	expect(
		leaks,
		`unresolved i18n keys on ${page.url()}:\n${leaks.join(", ")}`,
	).toEqual([]);
}

test.describe("i18n — no key leaks on any route", () => {
	for (const route of ALL_ROUTES) {
		test(
			`${route} — en is clean`,
			{ timeout: 60000 },
			async ({ page }) => {
				const hub = hubFor(route);

				await page.goto(hub);
				await page.waitForLoadState("networkidle");
				await page.evaluate(() => {
					window.localStorage.setItem("tensol.lang", "en");
					document.documentElement.lang = "en";
				});

				if (route !== hub) {
					await page.goto(route);
					await page.waitForLoadState("networkidle");
				}
				await assertNoKeyLeaks(page);
			},
		);
	}
});

test.describe("i18n — English-only language state", () => {
	test("stored non-English locale is normalized to en on /", async ({ page }) => {
		await page.addInitScript(() => {
			window.localStorage.setItem("tensol.lang", "fr");
		});
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		await expect(page.locator("html")).toHaveAttribute("lang", "en");
	});
});
