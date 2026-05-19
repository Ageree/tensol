/**
 * T047 — Real Yandex Cloud integration test (skipped by default).
 *
 * This file is the live-API complement to the offline mock-based suite in
 * `yandex.test.ts` (T046). It is the "real Yandex" layer of the two-tier
 * test strategy from research §R11 layer 2:
 *
 *   layer 1 — offline mocks (yandex.test.ts):
 *             every fetch/IAM/poll collaborator injected, runs in ms.
 *   layer 2 — real Yandex (this file):
 *             actually hits compute.api.cloud.yandex.net, spins a minimal
 *             Ubuntu VM (no Decepticon, no vps-agent stack), waits for the
 *             create operation to converge to `status=running`, then tears
 *             the instance down. Verifies the provider really does map the
 *             live REST surface 1:1 with the contract.
 *
 * Gating:
 *   - The entire `describe` block is wrapped in `describe.skipIf(!REAL)`
 *     where `REAL = process.env.TENSOL_TEST_REAL_YANDEX === "1"`.
 *   - Default `bun test` runs (CI, local, sprint loops) see the suite as
 *     "skipped" and never make a network call.
 *   - Operators run on demand:
 *       TENSOL_TEST_REAL_YANDEX=1 bun test src/vps/yandex-real.test.ts
 *     with `server/.env.yandex` sourced (per memory anchor
 *     project_tensol_blackbox_mvp_impl_handoff_2026-05-19).
 *
 * Defensive teardown:
 *   - `afterAll` always attempts `provider.teardownVm(spawnedInstanceId)`
 *     even when the assertions inside `test` throw, so a failed run does
 *     not leak a billable VM.
 *   - Teardown errors are caught + logged (never re-thrown) so they cannot
 *     mask the underlying assertion failure that triggered them.
 *
 * Constitution alignment:
 *   - I  — does not touch `external/decepticon/` (this test uses a minimal
 *          custom user-data that just creates a sentinel file).
 *   - VI — green-path integration test, no business logic mocked away.
 *   - VII — file ≤ 800 LOC (target ~150).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { ulid } from "../lib/ids";
import { createYandexCloudProvider } from "./yandex";
import type { CloudProvider } from "./provider";

const REAL_TEST = process.env.TENSOL_TEST_REAL_YANDEX === "1";

/**
 * Env vars required for the real-Yandex path. The provider factory itself
 * only hard-requires `YANDEX_PROD_FOLDER_ID`; the rest fall back to safe
 * defaults but are still required *operationally* (no network, no subnet,
 * no SSH key → either the VM never spawns or it spawns unreachable).
 */
const REQUIRED_ENV_VARS = [
  "YANDEX_SA_KEY_JSON",
  "YANDEX_PROD_FOLDER_ID",
  "YANDEX_PROD_NETWORK_ID",
  "YANDEX_PROD_SUBNET_ID",
  "YANDEX_PROD_SSH_PUBLIC_KEY",
] as const;

/** Max wall-clock for the create→running poll loop (Yandex p99 ~2–3min). */
const RUNNING_TIMEOUT_MS = 5 * 60 * 1000;

/** Inter-poll sleep — keeps API call rate well under any per-second cap. */
const POLL_INTERVAL_MS = 5000;

/** Overall `test()` timeout — wider than RUNNING_TIMEOUT_MS to leave room
 *  for the trailing teardown DELETE + a generous margin. */
const TEST_TIMEOUT_MS = 6 * 60 * 1000;

describe.skipIf(!REAL_TEST)("Yandex real provider (integration)", () => {
  let provider: CloudProvider;
  let spawnedInstanceId: string | null = null;

  beforeAll(() => {
    const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `real-Yandex integration test requires env vars: ${missing.join(", ")}`,
      );
    }
    provider = createYandexCloudProvider();
  });

  afterAll(async () => {
    // Defensive teardown: always attempt, never let errors propagate out
    // of the cleanup hook. A leaked VM costs ~₽1/hour and clutters the
    // folder; a thrown error from afterAll could mask the real assertion
    // failure in the test body.
    if (!spawnedInstanceId) return;
    try {
      await provider.teardownVm(spawnedInstanceId);
    } catch (err) {
      // Surface the failure for the operator running the test, but do
      // not re-throw — Bun's afterAll re-thrown error replaces the
      // original test failure in the reporter output.
      console.error(
        `[yandex-real] teardown failed for ${spawnedInstanceId}:`,
        err,
      );
    }
  });

  test(
    "spawns minimal Ubuntu VM, observes provisioning → running, then tears down",
    async () => {
      const scanId = ulid();

      // Minimal cloud-init — does NOT install Docker, does NOT pull
      // Decepticon. Just drops a sentinel file. The test does not SSH
      // into the box to verify the sentinel (would require ssh2 dep);
      // we trust the Yandex `status=RUNNING` enum as proof of boot.
      const userData = [
        "#!/bin/bash",
        "set -euo pipefail",
        "touch /var/lib/tensol-real-test-ready",
      ].join("\n");

      const spawned = await provider.spawnVm({ scanId, userData });
      spawnedInstanceId = spawned.instanceId;

      // Yandex IDs are lowercase-alphanumeric (e.g. "fhmnt6r…"). The
      // mock suite uses placeholder strings; this assertion catches
      // accidental UPPERCASE / hyphenation drift in the REST mapping.
      expect(spawned.instanceId).toMatch(/^[a-z0-9]+$/);
      expect(spawned.operationId).toMatch(/^[a-z0-9-]+$/);

      // Poll status until RUNNING (or timeout). The provider's create-op
      // poller already blocks on the op completing, but a successful op
      // does NOT guarantee `status=RUNNING` — Yandex marks ops `done`
      // once provisioning is initiated, with the instance transitioning
      // through PROVISIONING → STARTING → RUNNING afterward.
      const deadline = Date.now() + RUNNING_TIMEOUT_MS;
      let status = await provider.getStatus(spawned.instanceId);
      while (status.status !== "running" && Date.now() < deadline) {
        // Stop early on terminal-failure states to avoid burning the
        // full 5-minute budget on a guaranteed-doomed VM.
        if (status.status === "error" || status.status === "stopped") {
          throw new Error(
            `VM ${spawned.instanceId} reached terminal status="${status.status}" before RUNNING`,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        status = await provider.getStatus(spawned.instanceId);
      }

      expect(status.status).toBe("running");
      // Public IPv4 is attached once the VM enters RUNNING.
      expect(status.publicIp).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    },
    TEST_TIMEOUT_MS,
  );
});
