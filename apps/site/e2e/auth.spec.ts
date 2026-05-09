import { expect, test } from '@playwright/test';
import { attachConsoleAssertions } from './helpers/console.ts';

test.describe('/login', () => {
  test('renders, form present, email pre-filled', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('form')).toBeVisible();

    const emailInput = page.locator('input:not([type=password])').first();
    await expect(emailInput).toHaveValue('alex.k@acme.com');

    console$.assertClean();
  });

  test('lang switcher present', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[role=radiogroup][aria-label=Language]')).toBeVisible();
  });

  test('step 1 submit advances to MFA step', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Step 1 button: "Continue →" / "Продолжить →"
    const step1Btn = page.locator('form button').first();
    await step1Btn.click();

    await expect(page.locator('input[placeholder="123456"]')).toBeVisible();
  });

  test('step 2 submit navigates away from /login', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Advance to step 2
    const step1Btn = page.locator('form button').first();
    await step1Btn.click();
    await expect(page.locator('input[placeholder="123456"]')).toBeVisible();

    // Step 2 button text changes to "Sign in →" / "Войти →" — re-locate
    const step2Btn = page.locator('form button').first();
    await step2Btn.click();

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 5000 });
    expect(page.url()).not.toMatch(/\/login/);
  });

  test('email validation is deferred (no client-side format check)', async ({ page }) => {
    // Login.tsx does NOT validate email format — submit() advances step unconditionally.
    // This test documents the deferred state rather than asserting format rejection.
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.locator('input:not([type=password])').first();
    await emailInput.fill('not-an-email');

    // Should advance to step 2 regardless (no validation)
    const step1Btn = page.locator('form button').first();
    await step1Btn.click();

    await expect(page.locator('input[placeholder="123456"]')).toBeVisible();
  });
});

test.describe('/bootstrap', () => {
  test('renders without crash', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await page.goto('/bootstrap');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
    console$.assertClean();
  });
});

test.describe('/invite', () => {
  test('renders without crash', async ({ page }) => {
    const console$ = attachConsoleAssertions(page);
    await page.goto('/invite');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toBeVisible();
    console$.assertClean();
  });
});
