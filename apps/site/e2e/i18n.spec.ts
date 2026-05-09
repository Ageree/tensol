import { expect, test } from '@playwright/test';
import { escapeRegex, i18nKeys } from './fixtures/i18n-keys.ts';
import { switchLang } from './helpers/i18n.ts';

// Routes that have a lang switcher directly available without navigating.
// Strategy: switch lang on a "hub" route, then navigate to the target — TensolProvider is global.
const HUB_MARKETING = '/';
const HUB_APP = '/dashboard';
const HUB_AUTH = '/login';

function hubFor(route: string): string {
  if (route.startsWith('/dashboard') || route.startsWith('/projects') ||
      route.startsWith('/targets') || route.startsWith('/builder') ||
      route.startsWith('/approval') || route.startsWith('/live') ||
      route.startsWith('/findings') || route.startsWith('/reports') ||
      route.startsWith('/settings')) {
    return HUB_APP;
  }
  if (route.startsWith('/login') || route.startsWith('/bootstrap') || route.startsWith('/invite')) {
    return HUB_AUTH;
  }
  return HUB_MARKETING;
}

// All 17 real routes (no catchall)
const ALL_ROUTES = [
  '/',
  '/pricing',
  '/trust',
  '/contact',
  '/legal/privacy',
  '/legal/terms',
  '/legal/dpa',
  '/login',
  '/bootstrap',
  '/invite',
  '/dashboard',
  '/projects',
  '/targets',
  '/builder',
  '/approval',
  '/live',
  '/findings',
  '/reports',
  '/settings',
  '/err/401',
  '/err/403',
  '/err/404',
  '/err/500',
  '/err/offline',
] as const;

async function assertNoKeyLeaks(page: import('@playwright/test').Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  const leaks: string[] = [];
  for (const key of i18nKeys) {
    // Skip short keys — single common English words like "data", "view", "contact"
    // are valid i18n key names but also appear as real content. Min length 10
    // ensures we only catch actual camelCase key names like "heroBlurb", "pillarsEyebrow".
    if (typeof key !== 'string' || key.length < 10) continue;
    // Only flag camelCase keys — real i18n key leaks are always camelCase
    if (!/[a-z][A-Z]/.test(key)) continue;
    const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
    if (re.test(bodyText)) {
      leaks.push(key);
    }
  }
  expect(leaks, `unresolved i18n keys on ${page.url()}:\n${leaks.join(', ')}`).toEqual([]);
}

test.describe('i18n — no key leaks on any route', () => {
  for (const route of ALL_ROUTES) {
    test(`${route} — en and ru both clean`, async ({ page }) => {
      const hub = hubFor(route);

      // Switch to EN via hub
      await page.goto(hub);
      await page.waitForLoadState('networkidle');
      await switchLang(page, 'en');

      if (route !== hub) {
        await page.goto(route);
        await page.waitForLoadState('networkidle');
      }
      await assertNoKeyLeaks(page);

      // Switch to RU via hub
      await page.goto(hub);
      await page.waitForLoadState('networkidle');
      await switchLang(page, 'ru');

      if (route !== hub) {
        await page.goto(route);
        await page.waitForLoadState('networkidle');
      }
      await assertNoKeyLeaks(page);
    });
  }
});

test.describe('i18n — lang switch toggles aria-checked', () => {
  test('EN/RU toggle works on /', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await switchLang(page, 'en');
    const enBtn = page.locator('[role=radiogroup][aria-label=Language] button', { hasText: 'EN' });
    await expect(enBtn).toHaveAttribute('aria-checked', 'true');

    await switchLang(page, 'ru');
    const ruBtn = page.locator('[role=radiogroup][aria-label=Language] button', { hasText: 'RU' });
    await expect(ruBtn).toHaveAttribute('aria-checked', 'true');
  });
});
