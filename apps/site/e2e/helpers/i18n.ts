import type { Page } from '@playwright/test';

export async function switchLang(page: Page, lang: 'en' | 'ru'): Promise<void> {
  const switcher = page.locator('[role=radiogroup][aria-label=Language]');
  await switcher.waitFor({ state: 'visible' });
  const btn = switcher.locator(`button[aria-checked]`, { hasText: lang.toUpperCase() });
  const checked = await btn.getAttribute('aria-checked');
  if (checked !== 'true') {
    await btn.click();
  }
}

export async function getCurrentLang(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang ?? '');
}
