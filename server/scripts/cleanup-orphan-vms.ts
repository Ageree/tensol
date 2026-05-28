/**
 * T123 — Standalone CLI for the orphan-VM cleanup task.
 *
 * Per research §R10: invokable via `bun run cleanup-orphan-vms` (script
 * entry in package.json) on a cron from the host scheduler. Performs one
 * sweep of `createCleanupOrphanVmsTask` and exits with the appropriate
 * code.
 *
 * Provider note (post-GCP-pivot): the in-process server already runs this
 * same cleanup task on a 15-minute cadence (see server.ts T125). This
 * standalone entrypoint exists for host-cron / one-off operator use and
 * uses the GCP provider — the only live cloud rail. GCP has no "folder"
 * concept; the project is implicit in the SA JSON, so we pass a single
 * dummy folder id (the project id) and gcp.ts `listInstances` ignores the
 * param, mirroring server.ts.
 *
 * Why this lives outside `src/`:
 *   The script is an operational entrypoint, not part of the server
 *   library surface. Keeping it in `scripts/` mirrors `seed-golden-db.ts`
 *   and `debug-scan-order.ts` and prevents the cron tooling from
 *   accidentally bundling itself into the server runtime via TS path
 *   resolution.
 *
 * Env contract (read at startup, NOT logged):
 *   - `GCP_PROJECT_ID`   — required; absent → no-op (nothing to sweep).
 *   - `GOOGLE_APPLICATION_CREDENTIALS` — the SA JSON the provider needs.
 *   - `TENSOL_TELEGRAM_BOT_TOKEN`, `TENSOL_TELEGRAM_CHAT_ID` — required
 *      if the run deletes >0 VMs (the `sendMessage` call surfaces a clear
 *      TelegramSendError if absent).
 *
 * Exit codes:
 *   - 0  → tick completed (with or without deletions)
 *   - 1  → unhandled error / missing required env (GCP creds / token bag)
 *
 * Constitution alignment:
 *   - I  — never touches `external/decepticon/`.
 *   - VI — uses the production GCP provider only when the script runs on a
 *     real cron; tests use the task factory directly with a fake.
 *   - VII — file ≤ 100 LOC.
 */
import { createCleanupOrphanVmsTask } from "../src/jobs/handlers/cleanup-orphan-vms.ts";
import { createGcpCloudProvider } from "../src/vps/gcp.ts";
import { sendMessage } from "../src/notify/telegram.ts";

const TEST_MIN_AGE_MS = 30 * 60 * 1000;
const PROD_MIN_AGE_MS = 120 * 60 * 1000;

async function main(): Promise<void> {
  // GCP has no "folder" concept — the project is implicit in the SA JSON.
  // Pass the project id as a single dummy folder so the cleanup loop runs
  // once per tick; gcp.ts listInstances ignores the param (mirrors T125).
  const projectId = process.env.GCP_PROJECT_ID ?? "";
  const folderIds = projectId === "" ? [] : [projectId];

  if (folderIds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cleanup-orphan-vms] GCP_PROJECT_ID not set — nothing to do",
    );
    return;
  }

  const provider = createGcpCloudProvider();

  const listInstances = provider.listInstances;
  if (!listInstances) {
    throw new Error(
      "gcp provider missing listInstances — cleanup script cannot run",
    );
  }

  const task = createCleanupOrphanVmsTask({
    provider: {
      listInstances: listInstances.bind(provider),
      teardownVm: provider.teardownVm.bind(provider),
    },
    folderIds,
    namePrefixes: ["tensol-test-", "tensol-scan-"],
    minAgeMs: {
      "tensol-test-": TEST_MIN_AGE_MS,
      "tensol-scan-": PROD_MIN_AGE_MS,
    },
    sendAlert: async (text: string) => {
      await sendMessage(text);
    },
  });

  const result = await task.tick();
  // eslint-disable-next-line no-console
  console.log(
    `[cleanup-orphan-vms] scanned=${result.scanned} deleted=${result.deleted.length} errors=${result.errors.length}`,
  );
  if (result.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error("[cleanup-orphan-vms] errors:");
    for (const e of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`  - ${e}`);
    }
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    "[cleanup-orphan-vms] fatal:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
