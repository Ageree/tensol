# ADR 0008 — SPA popstate Event Semantics

- **Status:** Accepted
- **Date:** 2026-04-30
- **Tags:** spa-observer, browser-worker, s16-spa-discovery, s17-sf4

## Context

Sprint 16 implemented SPA route discovery via History.pushState observer injection.
The observer also captures popstate events (back/forward navigation). A decision was
needed: should popstate-discovered URLs be navigated (page.goto'd) or recorded only?

## Decision

popstate routes are discovery-only: recorded in `browser.spa.route.discovered` audit
with `navigated: false`, but NOT navigated via `page.goto()`.

## Rationale

1. Loop prevention: popstate fires when navigating *back* to a previously visited URL.
   Re-navigating would re-trigger pushState observers, creating infinite discovery loops.
2. Redundancy: the URL was reachable via the pushState chain; content already captured.
3. No new observations: popstate represents a return to prior state, not new content.
4. Audit completeness: recording popstate preserves full route history without duplicate work.

## Consequences

- `browser.spa.route.discovered` fires for both pushstate (navigated: true) and
  popstate (navigated: false).
- No `observations_browser` row created for popstate-only routes.
- `real-driver.ts` and `spa-observer.ts` carry explicit comments per this ADR.
- Unit test: method='popstate' route → no page.goto, navigated: false in audit.
