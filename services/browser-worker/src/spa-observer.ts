// Sprint 16 — SPA route observer.
//
// No Playwright import at module level: this file is unit-testable without a
// browser. SPA_OBSERVER_SCRIPT is injected via page.addInitScript(); it patches
// history.pushState and listens for popstate events, collecting discovered routes
// into window.__cs_spa_routes for later extraction via page.evaluate().

// Script string injected into the browser page via page.addInitScript().
// Runs before any page scripts so pushState patches take effect immediately.
export const SPA_OBSERVER_SCRIPT = `(function() {
  window.__cs_spa_routes = window.__cs_spa_routes || [];
  var orig = history.pushState.bind(history);
  history.pushState = function(state, title, url) {
    if (url) {
      try {
        window.__cs_spa_routes.push({
          url: String(new URL(String(url), location.href)),
          sourceUrl: location.href,
          method: 'pushstate',
        });
      } catch (e) {}
    }
    return orig(state, title, url);
  };
  // popstate = back/forward navigation to a previously visited URL.
  // Discovery-only: recorded for audit completeness, not re-navigated.
  // Navigating would re-trigger pushState observers and create crawl loops. See ADR 0008.
  window.addEventListener('popstate', function() {
    window.__cs_spa_routes.push({
      url: location.href,
      sourceUrl: document.referrer || location.href,
      method: 'popstate',
    });
  });
})();`;

export interface SpaRoute {
  readonly url: string;
  readonly sourceUrl: string;
  readonly method: 'pushstate' | 'popstate';
}

export const parseSpaRoutes = (raw: unknown): ReadonlyArray<SpaRoute> => {
  if (!Array.isArray(raw)) return [];
  const result: SpaRoute[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === 'object') {
      const { url, sourceUrl, method } = entry as {
        url: unknown;
        sourceUrl: unknown;
        method: unknown;
      };
      if (
        typeof url === 'string' &&
        typeof sourceUrl === 'string' &&
        (method === 'pushstate' || method === 'popstate')
      ) {
        result.push({ url, sourceUrl, method });
      }
    }
  }
  return result;
};

// Parses BROWSER_SPA_MAX_DEPTH env value to an integer in [0, 10].
// NaN, negative, >10 all fall back to default 3. Absent → default 3.
export const parseSpaMaxDepth = (raw: string | undefined): number => {
  if (raw === undefined) return 3;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 10) return 3;
  return n;
};
