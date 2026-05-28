/**
 * T123 — Standalone CLI for the orphan-VM cleanup task.
 *
 * Per research §R10: invokable via `bun run cleanup-orphan-vms` (script
 * entry in package.json) on a cron from the host scheduler. Performs one
 * sweep of `createCleanupOrphanVmsTask` and exits with the appropriate
 * code.
 *
 * Why this lives outside `src/`:
 *   The script is an operational entrypoint, not part of the server
 *   library surface. Keeping it in `scripts/` mirrors `seed-golden-db.ts`
 *   and `debug-scan-order.ts` and prevents the cron tooling from
 *   accidentally bundling itself into the server runtime via TS path
 *   resolution.
 *
 * Env contract (read at startup, NOT logged):
 *   - `YANDEX_TEST_FOLDER_ID`   — optional, defaults to absent
 *   - `YANDEX_PROD_FOLDER_ID`   — optional, defaults to absent
 *   - `TENSOL_TELEGRAM_BOT_TOKEN`, `TENSOL_TELEGRAM_CHAT_ID` — required
 *      if any folder is configured AND the run deletes >0 VMs (the
 *      `sendMessage` call surfaces a clear TelegramSendError if absent).
 *
 * Exit codes:
 *   - 0  → tick completed (with or without deletions)
 *   - 1  → unhandled error / missing required env (Yandex IAM / token bag)
 *
 * Constitution alignment:
 *   - I  — never touches `external/decepticon/`.
 *   - VI — uses the production Yandex provider only when the script runs
 *     on a real cron; tests use the task factory directly with a fake.
 *   - VII — file ≤ 100 LOC.
 */
import { createCleanupOrphanVmsTask } from "../src/jobs/handlers/cleanup-orphan-vms.ts";
import { createYandexCloudProvider } from "../src/vps/yandex.ts";
import { sendMessage } from "../src/notify/telegram.ts";

const TEST_MIN_AGE_MS = 30 * 60 * 1000;
const PROD_MIN_AGE_MS = 120 * 60 * 1000;

async function main(): Promise<void> {
  const testFolder = process.env.YANDEX_TEST_FOLDER_ID ?? "";
  const prodFolder = process.env.YANDEX_PROD_FOLDER_ID ?? "";
  const folderIds = [testFolder, prodFolder].filter((f) => f !== "");

  if (folderIds.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[cleanup-orphan-vms] no folder ids configured " +
        "(YANDEX_TEST_FOLDER_ID, YANDEX_PROD_FOLDER_ID) — nothing to do",
    );
    return;
  }

  // We build a Yandex provider per-folder because each folder may live
  // under a different service account. For MVP both folders share the
  // same IAM creds, so a single provider suffices.
  const provider = createYandexCloudProvider();

  const listInstances = provider.listInstances;
  if (!listInstances) {
    throw new Error(
      "yandex provider missing listInstances — cleanup script cannot run",
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
