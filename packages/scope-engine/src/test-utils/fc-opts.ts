// R8 — shared fast-check `numRuns` constants. Property tests import these so
// the floor is audit-grep-able. Per evaluator R8: URL=1000, IP=200, host/IDN=200.

export const URL_RUNS = 1000;
export const IP_RUNS = 200;
export const HOST_RUNS = 200;

export const fastCheckOpts = {
  url: { numRuns: URL_RUNS },
  ip: { numRuns: IP_RUNS },
  host: { numRuns: HOST_RUNS },
} as const;
