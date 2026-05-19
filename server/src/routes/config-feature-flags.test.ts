/**
 * T073 — unit tests for the feature-flags route.
 *
 * Coverage:
 *   1. Default response: TENSOL_YOOKASSA_LIVE unset → { yookassa_live: false }
 *   2. Enabled response: TENSOL_YOOKASSA_LIVE="true" → { yookassa_live: true }
 *
 * Env var management: each test snapshots & restores the env var so the
 * tests are order-independent and don't leak state into other suites.
 */
import { test, expect } from "bun:test";

import { createConfigFeatureFlagsRouter } from "./config-feature-flags.ts";

test("GET / returns yookassa_live:false by default", async () => {
  const orig = process.env.TENSOL_YOOKASSA_LIVE;
  delete process.env.TENSOL_YOOKASSA_LIVE;
  try {
    const router = createConfigFeatureFlagsRouter();
    const resp = await router.request("/");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { yookassa_live: boolean };
    expect(body).toEqual({ yookassa_live: false });
  } finally {
    if (orig !== undefined) process.env.TENSOL_YOOKASSA_LIVE = orig;
    else delete process.env.TENSOL_YOOKASSA_LIVE;
  }
});

test("GET / returns yookassa_live:true when env=true", async () => {
  const orig = process.env.TENSOL_YOOKASSA_LIVE;
  process.env.TENSOL_YOOKASSA_LIVE = "true";
  try {
    const router = createConfigFeatureFlagsRouter();
    const resp = await router.request("/");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { yookassa_live: boolean };
    expect(body).toEqual({ yookassa_live: true });
  } finally {
    if (orig !== undefined) process.env.TENSOL_YOOKASSA_LIVE = orig;
    else delete process.env.TENSOL_YOOKASSA_LIVE;
  }
});
