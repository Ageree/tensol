/**
 * T073 — unit tests for the feature-flags route.
 *
 * Coverage:
 *   1. Default response: all gates unset → every flag false.
 *   2. legacy paid flag enabled → yookassa_live:true (others still false).
 *   3. F1/F2 enabled → research_enabled / exploit_enabled true.
 *
 * Env var management: each test snapshots & restores the env vars so the
 * tests are order-independent and don't leak state into other suites.
 */
import { expect, test } from "bun:test";

import { createConfigFeatureFlagsRouter } from "./config-feature-flags.ts";

const FLAG_ENVS = [
  "TENSOL_YOOKASSA_LIVE",
  "TENSOL_BILLING_PROVIDER",
  "TENSOL_RESEARCH_ENABLED",
  "TENSOL_EXPLOIT_ENABLED",
] as const;

/** Run `fn` with the three flag envs set to `overrides`, restoring after. */
async function withEnv(
  overrides: Partial<Record<(typeof FLAG_ENVS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const snapshot = new Map(FLAG_ENVS.map((k) => [k, process.env[k]]));
  for (const k of FLAG_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of FLAG_ENVS) {
      const orig = snapshot.get(k);
      if (orig !== undefined) process.env[k] = orig;
      else delete process.env[k];
    }
  }
}

async function getFlags(): Promise<Record<string, boolean | string>> {
  const router = createConfigFeatureFlagsRouter();
  const resp = await router.request("/");
  expect(resp.status).toBe(200);
  return (await resp.json()) as Record<string, boolean>;
}

test("GET / returns all flags false by default", async () => {
  await withEnv({}, async () => {
    expect(await getFlags()).toEqual({
      yookassa_live: false,
      billing_live: true,
      billing_provider: "manual",
      research_enabled: false,
      exploit_enabled: false,
    });
  });
});

test("GET / returns legacy yookassa_live:true when env=true (others false)", async () => {
  await withEnv({ TENSOL_YOOKASSA_LIVE: "true" }, async () => {
    expect(await getFlags()).toEqual({
      yookassa_live: true,
      billing_live: true,
      billing_provider: "manual",
      research_enabled: false,
      exploit_enabled: false,
    });
  });
});

test("GET / exposes oxapay billing provider when configured", async () => {
  await withEnv({ TENSOL_BILLING_PROVIDER: "oxapay" }, async () => {
    expect(await getFlags()).toEqual({
      yookassa_live: false,
      billing_live: true,
      billing_provider: "oxapay",
      research_enabled: false,
      exploit_enabled: false,
    });
  });
});

test("GET / exposes F1/F2 gates: research_enabled + exploit_enabled", async () => {
  await withEnv(
    { TENSOL_RESEARCH_ENABLED: "true", TENSOL_EXPLOIT_ENABLED: "1" },
    async () => {
      expect(await getFlags()).toEqual({
        yookassa_live: false,
        billing_live: true,
        billing_provider: "manual",
        research_enabled: true,
        exploit_enabled: true,
      });
    },
  );
});
