import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const DEFAULT_ALLOW: RegExp[] = [
  /Download the React DevTools/,
  /ReactDOM\.render is no longer supported/,
  /Warning: ReactDOM\.render/,
];

export function attachConsoleAssertions(page: Page) {
  const errors: string[] = [];

  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
  });

  return {
    assertClean(allow: RegExp[] = DEFAULT_ALLOW) {
      const filtered = errors.filter((e) => !allow.some((r) => r.test(e)));
      expect(filtered, `unexpected console errors:\n${filtered.join('\n')}`).toEqual([]);
    },
  };
}
