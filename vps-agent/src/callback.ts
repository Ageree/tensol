/**
 * callback — POSTs a final scan result back to the Tensol backend webhook
 * with HMAC-SHA256 signing over the raw JSON body and exponential-backoff
 * retry on transient failures.
 *
 * Wire contract (see `specs/001-backend-v2/contracts/webhook.md`):
 *   Headers:
 *     Content-Type: application/json
 *     X-Tensol-Scan-Id: <ULID>
 *     X-Tensol-Signature: <lower-case hex HMAC-SHA256 of raw body>
 *   Body shape:
 *     { scan_id, status: "done"|"failed", failure_reason, usage, findings[] }
 *
 * Retry policy:
 *   - 2xx                → success, return immediately.
 *   - 4xx                → permanent failure (auth/signature/contract) — no retry.
 *   - 5xx / network err  → exponential backoff (1s, 5s, 25s, 125s, ...) up to
 *                          `maxAttempts` total attempts (default 5).
 *
 * Self-shutdown is the caller's responsibility (T073 wires `process.exit(0)`
 * after this function returns). This keeps the function pure-ish and unit
 * testable without process-mutating side effects.
 */

import { createHmac } from "node:crypto";
import type { CollectedFinding } from "./findings-collector.ts";

export type CallbackPayload = {
  scan_id: string;
  status: "done" | "failed";
  failure_reason: string | null;
  usage: { tokens: number; usd_cents: number } | null;
  findings: CollectedFinding[];
};

export type SendCallbackOpts = {
  webhookUrl: string;
  signKey: string;
  payload: CallbackPayload;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  initialDelayMs?: number;
};

export type CallbackResult =
  | { ok: true; attempts: number; status: number }
  | {
      ok: false;
      attempts: number;
      lastStatus?: number;
      lastError?: string;
    };

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const BACKOFF_MULTIPLIER = 5;

/**
 * Default sleep using setTimeout. Mockable via `opts.sleep` for tests.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function sendCallback(
  opts: SendCallbackOpts,
): Promise<CallbackResult> {
  const {
    webhookUrl,
    signKey,
    payload,
    fetchImpl = fetch,
    sleep = defaultSleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  } = opts;

  // Serialize once. The exact bytes here are what we sign AND send — the
  // backend verifies the signature over the raw body it receives, so both
  // sides MUST see identical bytes.
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", signKey)
    .update(rawBody)
    .digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Tensol-Scan-Id": payload.scan_id,
    "X-Tensol-Signature": signature,
  };

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    let status: number | undefined;
    let networkErr: Error | undefined;

    try {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers,
        body: rawBody,
      });
      status = res.status;
    } catch (err) {
      networkErr = err instanceof Error ? err : new Error(String(err));
    }

    if (status !== undefined) {
      // 2xx: success.
      if (status >= 200 && status < 300) {
        return { ok: true, attempts, status };
      }
      // 4xx: permanent failure — auth/signature/contract errors don't self-heal.
      if (status >= 400 && status < 500) {
        return { ok: false, attempts, lastStatus: status };
      }
      // 5xx: transient — fall through to retry logic.
      lastStatus = status;
      lastError = `HTTP ${status}`;
    } else if (networkErr) {
      lastError = networkErr.message;
      lastStatus = undefined;
    }

    // Out of attempts: give up.
    if (attempts >= maxAttempts) {
      const final: CallbackResult = { ok: false, attempts };
      if (lastStatus !== undefined) final.lastStatus = lastStatus;
      if (lastError !== undefined) final.lastError = lastError;
      return final;
    }

    // Exponential backoff: 1s, 5s, 25s, 125s, 625s, ...
    // delay = initialDelayMs * BACKOFF_MULTIPLIER^(attempts-1)
    const delay =
      initialDelayMs * Math.pow(BACKOFF_MULTIPLIER, attempts - 1);
    await sleep(delay);
  }

  // Unreachable in practice — the while-loop returns before exhausting,
  // but TypeScript needs a terminal return.
  const final: CallbackResult = { ok: false, attempts };
  if (lastStatus !== undefined) final.lastStatus = lastStatus;
  if (lastError !== undefined) final.lastError = lastError;
  return final;
}
