import { expect, test } from '@playwright/test';
import { attachConsoleAssertions } from './helpers/console.ts';

const APP_ROUTES = [
  '/dashboard',
  '/projects',
  '/targets',
  '/builder',
  '/approval',
  '/live',
  '/findings',
  '/reports',
  '/settings',
] as const;

const ERROR_ROUTES = [
  '/err/401',
  '/err/403',
  '/err/404',
  '/err/500',
  '/err/offline',
] as const;

test.describe('app shell routes — smoke', () => {
  for (const route of APP_ROUTES) {
    test(`${route} renders, AppShell present, heading visible, no console errors`, async ({
      page,
    }) => {
      const console$ = attachConsoleAssertions(page);
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      // AppShell root: data-screen-label="shell-*"
      await expect(page.locator('[data-screen-label^="shell-"]')).toBeVisible();

      // Sticky left nav aside
      await expect(page.locator('aside').first()).toBeVisible();

      // At least one heading visible
      const heading = page.locator('h1, h2').filter({ visible: true }).first();
      await expect(heading).toBeVisible();
      const text = await heading.innerText();
      expect(text.trim().length).toBeGreaterThan(0);

      console$.assertClean();
    });
  }
});

test.describe('error routes', () => {
  for (const route of ERROR_ROUTES) {
    test(`${route} renders without crash`, async ({ page }) => {
      const console$ = attachConsoleAssertions(page);
      await page.goto(route);
      await page.waitForLoadState('networkidle');

      await expect(page.locator('[data-screen-label^="shell-"]')).toBeVisible();

      const heading = page.locator('h2').filter({ visible: true }).first();
      await expect(heading).toBeVisible();

      console$.assertClean();
    });
  }

  test('/err/banana falls back to 404 content', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await page.goto('/err/banana');
    await page.waitForLoadState('networkidle');

    // ErrorScreen falls back to '404' for unknown kinds (line 28 of ErrorScreen.tsx)
    await expect(page.locator('[data-screen-label^="shell-"]')).toBeVisible();
    const heading = page.locator('h2').filter({ visible: true }).first();
    await expect(heading).toBeVisible();
    const text = await heading.innerText();
    expect(text.trim().length).toBeGreaterThan(0);

    console$.assertClean();
  });

  test('/this-route-does-not-exist redirects to /err/404', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await page.waitForURL('**/err/404', { timeout: 5000 });
    expect(page.url()).toMatch(/\/err\/404/);
  });
});
