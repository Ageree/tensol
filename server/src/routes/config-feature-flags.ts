/**
 * T073 — `GET /v1/config/feature-flags` route (US1 surface).
 *
 * Public surface (mounted at `/v1/config/feature-flags` from `server.ts`):
 *
 *   GET / → { yookassa_live: boolean }
 *
 * Per openapi.yaml §/v1/config/feature-flags + components.schemas.FeatureFlags.
 *
 * Constitution IX: this route has no request body, so no Zod validator is
 * required. The single flag value is read at request time via the T019
 * `isYookassaLive()` helper so flips of TENSOL_YOOKASSA_LIVE take effect
 * on the next request (no boot-time snapshot).
 *
 * Why a factory (no deps yet):
 *   Future runtime flags will likely accept DI'd config/clock; keeping the
 *   factory shape now means downstream wiring stays uniform across all the
 *   002 routes (scan-orders / scans / webhooks-scan-complete / feature-flags).
 */
import { Hono } from "hono";

import { isYookassaLive } from "../lib/feature-flags.ts";

/**
 * Build the feature-flags subrouter. Mount at `/v1/config/feature-flags`.
 */
export function createConfigFeatureFlagsRouter(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ yookassa_live: isYookassaLive() }, 200));
  return app;
}
