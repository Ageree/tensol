# T005 — Playwright + Chromium Evidence

**Date**: 2026-05-19
**Task**: T005 [P] Add dev dep `playwright` + browsers to `apps/site/package.json` (if not already present)

## Status: VERIFIED — no package.json changes needed

## Package Verification

- `@playwright/test`: `^1.49.0` declared in `apps/site/package.json` devDependencies (line 20)
- Resolved CLI version: `Version 1.60.0` (`bunx playwright --version`)
- Note: `playwright` runtime package is NOT a direct dep — `@playwright/test` re-exports the runtime, which is the standard pattern. No runtime-only dep needed.

## Config File

- Path: `apps/site/playwright.config.ts`
- testDir: `./e2e`
- baseURL: `http://127.0.0.1:5175` (env override `PW_BASE_URL`)
- Projects: `chromium-desktop` (1440x900), `chromium-mobile` (Pixel 7)
- Global setup/teardown wired in

## Browser Install

- Command: `bunx playwright install chromium`
- Outcome: Already-cached install; no download needed
- Install path: `~/Library/Caches/ms-playwright/chromium-1223` (341 MB)
- Headless shell: `~/Library/Caches/ms-playwright/chromium_headless_shell-1223` (190 MB)
- Total chromium footprint: ~531 MB
- Platform: darwin-arm64
- firefox + webkit deliberately NOT installed (smoke tests are chromium-only per config projects)

## Files Modified

None. `apps/site/package.json` already declares the dep. Lockfile untouched.

## Conclusion

T005 satisfied. Chromium browser ready for `bun run test:e2e` invocation.
