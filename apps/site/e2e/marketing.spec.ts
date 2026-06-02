import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { attachConsoleAssertions } from './helpers/console.ts';

const MARKETING_PAGES = [
  '/',
  '/pricing',
  '/solutions',
  '/solutions/blackbox',
  '/solutions/whitebox',
  '/solutions/pr-review',
  '/trust',
  '/resources',
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
] as const;

const DOM_READY_TIMEOUT_MS = 5_000;
const PAGE_READY_TIMEOUT_MS = 15_000;

async function gotoDomReady(page: Page, route: string) {
  try {
    await page.goto(route, {
      waitUntil: 'domcontentloaded',
      timeout: DOM_READY_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Timeout')) throw error;
  }

  await expect.poll(() => new URL(page.url()).pathname).toBe(route);
}

async function expectSingleVisiblePageH1(page: Page) {
  const visibleH1 = page.locator('h1').filter({ visible: true });

  await expect(visibleH1.first()).toBeVisible({ timeout: PAGE_READY_TIMEOUT_MS });
  expect(await visibleH1.count()).toBe(1);
}

test.describe('marketing routes — smoke', () => {
  for (const route of MARKETING_PAGES) {
    test(`${route} loads, h1 visible, no console errors`, async ({ page }) => {
      const console$ = attachConsoleAssertions(page);
      await gotoDomReady(page, route);

      await expectSingleVisiblePageH1(page);

      console$.assertClean();
    });
  }
});

test.describe('/contact', () => {
  test('loads, h1 visible, no console errors', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await gotoDomReady(page, '/contact');

    await expectSingleVisiblePageH1(page);
    await expect(page.getByText(/152-FZ|152-ФЗ/i)).toHaveCount(0);

    console$.assertClean();
  });

  test('form fields present and submit button is type=submit', async ({ page }) => {
    await gotoDomReady(page, '/contact');

    await expect(page.locator('input[autoComplete=name]')).toBeVisible();
    await expect(page.locator('input[autoComplete=username]')).toBeVisible();
    await expect(page.locator('input[autoComplete=tel]')).toBeVisible();
    await expect(page.locator('button[type=submit]')).toBeVisible();
  });

  test('empty submit shows validation errors, URL stays /contact', async ({ page }) => {
    await gotoDomReady(page, '/contact');

    const submit = page.locator('button[type=submit]');
    await expect(submit).toBeVisible();
    await submit.click();

    await expect(page).toHaveURL(/\/contact/);
    await expect(page.getByText('Required').first()).toBeVisible();
  });

  test('invalid contact details keep the user on /contact', async ({ page }) => {
    await gotoDomReady(page, '/contact');

    await page.locator('input[autoComplete=name]').fill('Alex Karpov');
    await page.locator('input[autoComplete=username]').fill('bad handle!');
    await page.locator('input[autoComplete=tel]').fill('123');
    await page.locator('button[type=submit]').click();

    await expect(page).toHaveURL(/\/contact/);
    await expect(page.getByText(/Telegram handle must be/i).first()).toBeVisible();
  });
});

test.describe('marketing — html lang attribute', () => {
  test('default lang is en', async ({ page }) => {
    await gotoDomReady(page, '/');
    await expectSingleVisiblePageH1(page);
    const lang = await page.evaluate(() => document.documentElement.lang);
    expect(lang).toBe('en');
  });
});

test.describe('marketing homepage proof section', () => {
  test('uses the requested proof heading copy', async ({ page }) => {
    await gotoDomReady(page, '/');
    await expectSingleVisiblePageH1(page);

    await expect(page.locator('#minimal-proof-title')).toHaveText(
      'We protect teams who want to ship fast as @£!%',
    );
  });
});
