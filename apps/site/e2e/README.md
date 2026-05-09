# Playwright E2E tests — apps/site

## First-time setup

```bash
cd apps/site
bun install
bunx playwright install chromium
```

Note: `@playwright/test` runs on Node.js. `bunx playwright test` works because Bun shells out
to the Playwright CLI which runs in Node mode.

Lighthouse binaries need Chrome download only on first install; after that they work offline.

## Running tests

```bash
# All functional specs (boots dev server in tmux automatically)
bunx playwright test --project=chromium-desktop

# Specific spec
bunx playwright test e2e/marketing.spec.ts --project=chromium-desktop

# Use already-running dev server
PW_BASE_URL=http://127.0.0.1:5175 bunx playwright test --project=chromium-desktop
```

The global-setup boots the dev server in a tmux session called `qa-dev` and kills it in
global-teardown. If port 5175 is already up, it skips the boot and leaves whatever is running.

## Visual regression (Sprint 3)

```bash
# First run / intentional design change — update baselines
bunx playwright test e2e/visual.spec.ts --update-snapshots

# Normal run — diff against baselines
bunx playwright test e2e/visual.spec.ts
```

Baselines are committed to `e2e/__screenshots__/`. They are OS-specific (macOS-arm64).
Linux CI should regenerate under a separate Playwright project tag.

## Debugging failures

```bash
bunx playwright test --ui                   # visual UI mode
bunx playwright show-report playwright-report/
```

On failure, screenshots saved to `test-results/`. Videos retained on failure.

## Allow-listed console noise

React 19 dev-mode emits some warnings that are filtered by default in `helpers/console.ts`:
- `Download the React DevTools` (type=info, already excluded by error-only filter)
- `ReactDOM.render is no longer supported` (legacy warning)

## i18n key-leak detection

`e2e/fixtures/i18n-keys.ts` imports `TENSOL_I18N.en` at runtime and builds a live key list.
When a new top-level i18n key is added to `src/i18n.ts`, the test automatically picks it up.
No manual sync needed.
