/**
 * T123 — `cleanup_orphan_vms` periodic task.
 *
 * Style: cron-style sweeper, NOT an event-driven job-payload handler. The
 * server bootstrap (T125) invokes this on a wall-clock cadence (every
 * 15 minutes per research §R10), and the standalone CLI in
 * `scripts/cleanup-orphan-vms.ts` invokes the same `tick()` once and exits.
 *
 * Why it exists (research §R10):
 *   Belt-and-braces against teardown bugs. Even if `afterAll` / the
 *   teardown_scan_vm job has a defect, no VM lives past its grace
 *   window. The Telegram alert on every nonzero cleanup makes silent
 *   leakage impossible.
 *
 * Per-prefix grace windows (research §R10):
 *   - `tensol-test-*`  → 30 min (CI / integration smokes)
 *   - `tensol-scan-*`  → 120 min (~30% margin over the 90-min scan timeout)
 *
 * Sweep algorithm:
 *   1. For each folder in `deps.folderIds`, call `provider.listInstances`.
 *      A throw / missing-method on one folder must not abort the run —
 *      we swallow + `errors.push` so the other folders still get scanned.
 *   2. For each instance, look up the first matching name prefix in
 *      `deps.namePrefixes`. Skip if no prefix matches (instance is not
 *      Tensol-owned — leave it alone).
 *   3. Check `now - inst.createdAt >= deps.minAgeMs[prefix]`. Skip if
 *      younger than grace.
 *   4. Call `provider.teardownVm(inst.id)`. On success push to `deleted`;
 *      on throw push `<id>: <message>` to `errors`. Errors never block
 *      the next iteration — the next tick retries.
 *   5. After the sweep, if `deleted.length > 0` call `deps.sendAlert(text)`.
 *      Alert format includes the deleted count, the error count, and up
 *      to the first 10 deleted instance ids (truncates pathological
 *      operator-side message lengths).
 *
 * Why we DON'T emit signed audit:
 *   This is an operational / out-of-band task. Cleanup runs are an SRE
 *   concern (Telegram alert IS the audit trail per research §R10). The
 *   audit chain models per-scan business events; orphan cleanup is not
 *   tied to a single scan_order. Constitution X: audit covers user-facing
 *   business events, not cron-side housekeeping.
 *
 * Constitution alignment:
 *   - I  — no `external/decepticon/` touchpoints.
 *   - VI — pure DI: provider + sendAlert + now are injectable; default
 *     test fixture is `FakeCloudProvider` (extended in T123 with
 *     `seedInstance` + `listInstances`).
 *   - VII — file aimed at ≤ 250 LOC.
 *   - IX — no Zod here (not a route handler); contract = TypeScript types.
 *
 * Return value: `{ deleted, errors, scanned }`. The standalone CLI prints
 * this; the cron timer in `server.ts` swallows it (with an error log on
 * unhandled throws).
 */

import type { VmInstanceSummary } from "../../vps/provider.ts";
import { now as defaultNow } from "../../lib/time.ts";

/**
 * Minimal provider surface this task needs. Deliberately narrower than
 * `CloudProvider` (which has 5 methods) so the task can be wired against
 * any object that exposes just `listInstances` + `teardownVm` — handy
 * for the standalone script's wrapper composition.
 */
export interface CleanupOrphanProvider {
  listInstances(folderId: string): Promise<VmInstanceSummary[]>;
  teardownVm(instanceId: string): Promise<{ operationId?: string }>;
}

/** Dependency bag for `createCleanupOrphanVmsTask`. */
export interface CleanupOrphanVmsDeps {
  readonly provider: CleanupOrphanProvider;
  /**
   * List of cloud-side folder ids to sweep. Empty list = task is a no-op
   * (logged, not an error) so dev environments without env vars can boot
   * without crashing.
   */
  readonly folderIds: readonly string[];
  /**
   * Name prefixes that mark a VM as Tensol-owned (anything else is
   * left alone). The first prefix that matches the instance name wins —
   * order matters when prefixes overlap (none do, in practice).
   */
  readonly namePrefixes: readonly string[];
  /**
   * Per-prefix grace window (millis). Instances younger than this for
   * their matched prefix are spared. Missing key → 30 min default.
   */
  readonly minAgeMs: Readonly<Record<string, number>>;
  /**
   * Operator-side notification. Called at most once per tick, only when
   * `deleted.length > 0`. Errors thrown here propagate up (caller
   * decides whether to retry).
   */
  readonly sendAlert: (text: string) => Promise<void>;
  /** Wall clock override (testing). Defaults to `lib/time.ts now()`. */
  readonly now?: () => number;
}

/** Result of one sweep. */
export interface CleanupOrphanVmsResult {
  /** Instance ids whose teardownVm call resolved successfully. */
  readonly deleted: ReadonlyArray<string>;
  /** `<id>: <message>` for each teardown that threw. */
  readonly errors: ReadonlyArray<string>;
  /** Total instances enumerated across every folder (orphans + non-orphans). */
  readonly scanned: number;
}

/** Public handle returned by `createCleanupOrphanVmsTask`. */
export interface CleanupOrphanVmsTask {
  tick(currentNow?: number): Promise<CleanupOrphanVmsResult>;
}

/** Fallback grace window when a prefix isn't in `minAgeMs`. */
const FALLBACK_MIN_AGE_MS = 30 * 60 * 1000;

/** Hard cap on the number of ids quoted in the Telegram alert body. */
const ALERT_ID_QUOTE_LIMIT = 10;

/**
 * Build a `cleanup_orphan_vms` task handle closing over the injected deps.
 *
 * Pure factory — no side effects until `tick()` is invoked. Each call to
 * `tick()` performs one full sweep across `deps.folderIds`.
 */
export function createCleanupOrphanVmsTask(
  deps: CleanupOrphanVmsDeps,
): CleanupOrphanVmsTask {
  const {
    provider,
    folderIds,
    namePrefixes,
    minAgeMs,
    sendAlert,
    now = defaultNow,
  } = deps;

  return {
    async tick(currentNow?: number): Promise<CleanupOrphanVmsResult> {
      const ts = currentNow ?? now();
      const deleted: string[] = [];
      const errors: string[] = [];
      let scanned = 0;

      for (const folderId of folderIds) {
        let instances: VmInstanceSummary[];
        try {
          instances = await provider.listInstances(folderId);
        } catch (err) {
          errors.push(
            `listInstances(${folderId}): ${errToString(err)}`,
          );
          continue;
        }
        scanned += instances.length;

        for (const inst of instances) {
          const prefix = namePrefixes.find((p) => inst.name.startsWith(p));
          if (!prefix) continue;
          const grace = minAgeMs[prefix] ?? FALLBACK_MIN_AGE_MS;
          const age = ts - inst.createdAt;
          if (age < grace) continue;

          try {
            await provider.teardownVm(inst.id);
            deleted.push(inst.id);
          } catch (err) {
            errors.push(`${inst.id}: ${errToString(err)}`);
          }
        }
      }

      if (deleted.length > 0) {
        await sendAlert(buildAlertBody(deleted, errors));
      }

      return { deleted, errors, scanned };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers (private; not exported)
// ───────────────────────────────────────────────────────────────────────────

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "<unstringifiable error>";
  }
}

function buildAlertBody(
  deleted: ReadonlyArray<string>,
  errors: ReadonlyArray<string>,
): string {
  const head = `Orphan VM cleanup: ${deleted.length} deleted, ${errors.length} errors.`;
  const quoted = deleted
    .slice(0, ALERT_ID_QUOTE_LIMIT)
    .map((id) => `• ${id}`)
    .join("\n");
  const omitted =
    deleted.length > ALERT_ID_QUOTE_LIMIT
      ? `\n…and ${deleted.length - ALERT_ID_QUOTE_LIMIT} more.`
      : "";
  return `${head}\n${quoted}${omitted}`;
}
