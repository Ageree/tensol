import type { Page } from "@playwright/test";

export async function switchLang(page: Page, lang: "en" | "ru"): Promise<void> {
	const switcher = page.locator("[role=radiogroup][aria-label=Language]");
	const hasVisibleSwitcher = await switcher
		.waitFor({ state: "visible", timeout: 1000 })
		.then(() => true)
		.catch(() => false);

	if (hasVisibleSwitcher) {
		const btn = switcher.locator("button[aria-checked]", {
			hasText: lang.toUpperCase(),
		});
		const checked = await btn.getAttribute("aria-checked");
		if (checked !== "true") {
			await btn.click();
		}
	} else {
		await page.evaluate((nextLang) => {
			window.localStorage.setItem("tensol.lang", nextLang);
			document.documentElement.lang = nextLang;
		}, lang);
		await page.reload({ waitUntil: "networkidle" });
	}

	await page.waitForFunction(
		(nextLang) => document.documentElement.lang === nextLang,
		lang,
	);
}

export async function getCurrentLang(page: Page): Promise<string> {
	return page.evaluate(() => document.documentElement.lang ?? "");
}
