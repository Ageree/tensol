# Sprint 1 Contract — Playwright E2E

**Status:** APPROVED by evaluator-quality
**Date:** 2026-05-09

## Files to create

```
apps/site/playwright.config.ts
apps/site/e2e/README.md
apps/site/e2e/global-setup.ts
apps/site/e2e/global-teardown.ts
apps/site/e2e/fixtures/routes.ts
apps/site/e2e/fixtures/i18n-keys.ts
apps/site/e2e/helpers/dev-server.ts
apps/site/e2e/helpers/console.ts
apps/site/e2e/helpers/i18n.ts
apps/site/e2e/marketing.spec.ts
apps/site/e2e/auth.spec.ts
apps/site/e2e/dashboard.spec.ts
apps/site/e2e/i18n.spec.ts
```

NO visual.spec.ts in Sprint 1 (Sprint 3 deliverable).

`apps/site/package.json` — add devDep `@playwright/test ^1.49.0` + script `"test:e2e": "playwright test"`.

## Pass gate

`bunx playwright test --project=chromium-desktop` exits 0.

## Key decisions

- `i18n-keys.ts` uses `TENSOL_I18N.en` (the public export) — NOT `en` directly (not exported)
- `[role=radiogroup][aria-label=Language]` confirmed in `LangSwitcher.tsx:23-24`
- h1 count: exactly 1 per marketing route (Contact success state is mutually exclusive)
- ErrorScreen: unknown kinds fall back to '404', renders h2 not h1
- Login: 2-step MFA, no email validation, step2 navigates to /dashboard
