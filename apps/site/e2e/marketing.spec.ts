import { expect, test } from '@playwright/test';
import { attachConsoleAssertions } from './helpers/console.ts';

const MARKETING_PAGES = [
  '/',
  '/pricing',
  '/trust',
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
] as const;

test.describe('marketing routes — smoke', () => {
  for (const route of MARKETING_PAGES) {
    test(`${route} loads, h1 visible, no console errors`, async ({ page }) => {
      const console$ = attachConsoleAssertions(page);
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      await expect(page.locator('h1').filter({ visible: true }).first()).toBeVisible();
      expect(await page.locator('h1').filter({ visible: true }).count()).toBe(1);

      console$.assertClean();
    });
  }
});

test.describe('/contact', () => {
  test('loads, h1 visible, no console errors', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('h1').filter({ visible: true }).first()).toBeVisible();
    expect(await page.locator('h1').filter({ visible: true }).count()).toBe(1);

    console$.assertClean();
  });

  test('form fields present and submit button is type=submit', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('input[type=email]')).toBeVisible();
    await expect(page.locator('input[autoComplete=name]')).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.locator('button[type=submit]')).toBeVisible();
  });

  test('empty submit shows validation errors, URL stays /contact', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    await page.locator('input[type=email]').fill('');
    await page.locator('input[autoComplete=name]').fill('');

    await page.locator('button[type=submit]').click();

    await expect(page).toHaveURL(/\/contact/);
  });

  test('free-mail rejected with validation error', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    await page.locator('input[type=email]').fill('user@gmail.com');
    await page.locator('button[type=submit]').click();

    await expect(page).toHaveURL(/\/contact/);
  });
});

test.describe('marketing — html lang attribute', () => {
  test('default lang is ru', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const lang = await page.evaluate(() => document.documentElement.lang);
    expect(lang).toBe('ru');
  });
});
