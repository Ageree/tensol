/**
 * T041 — Yandex Cloud long-running operations: polling with exponential
 * backoff and a 10-minute total cap.
 *
 * Per research §R4: every state-changing Yandex API call returns an
 * `Operation` object with `done: false`. The caller polls
 * `GET https://operation.api.cloud.yandex.net/operations/{id}` until
 * `done: true`, backing off 1s → 2s → 4s → max 8s, abandoning after 10
 * minutes of total wall-clock time.
 *
 * This module returns the parsed `Operation` verbatim — including the
 * `error` field — so callers (`yandex.ts`) can distinguish success
 * (`done && !error`) from operation-level failure (`done && error`). HTTP
 * errors from the polling endpoint itself bubble up as thrown `Error`s.
 *
 * Dependencies are injected (`fetcher`, `sleep`, `now`, `getToken`,
 * `timeoutMs`) so tests run in milliseconds without real wall-clock waits.
 */

import { getIamToken } from "./yandex-iam";

const OPERATION_BASE_URL = "https://operation.api.cloud.yandex.net/operations";
/** Total wall-clock budget for a single `pollOperation` call. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Backoff schedule (ms). The final entry is repeated forever. */
const BACKOFF_SEQ_MS: ReadonlyArray<number> = [1000, 2000, 4000, 8000];

/**
 * Parsed Yandex Operation. The `done` flag is the terminal signal;
 * `error` and `response` are populated mutually-exclusively when
 * `done === true`. Both `metadata` and `response` are typed as `unknown`
 * because their shape depends on the originating API call (spawn vs
 * teardown vs ...).
 */
export type Operation = {
  id: string;
  description?: string;
  createdAt?: string;
  createdBy?: string;
  modifiedAt?: string;
  done: boolean;
  error?: { code: number; message: string; details?: unknown[] };
  response?: unknown;
  metadata?: unknown;
};

export type PollOperationOpts = {
  /** Inject a fetch impl for tests; defaults to global `fetch`. */
  fetcher?: typeof fetch;
  /** Inject a sleep impl for tests; defaults to `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Inject a clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Inject a token source (rotated tokens supported). Defaults to the
   * shared cached singleton in `./yandex-iam.ts`.
   */
  getToken?: () => Promise<string>;
  /** Override the 10-minute default total budget (tests, custom callers). */
  timeoutMs?: number;
};

/**
 * Polls a Yandex operation until `done: true` or the total budget expires.
 *
 * Returns the parsed `Operation` (including any `error` field). Throws if:
 *   - the HTTP polling request fails (non-2xx)
 *   - `timeoutMs` elapses before `done === true`
 */
export async function pollOperation(
  opId: string,
  opts: PollOperationOpts = {},
): Promise<Operation> {
  const fetcher = opts.fetcher ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const getToken = opts.getToken ?? (() => getIamToken());
  const nowFn = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const start = nowFn();
  let attempt = 0;

  while (true) {
    const token = await getToken();
    const resp = await fetcher(`${OPERATION_BASE_URL}/${encodeURIComponent(opId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const detail = await readBodySafe(resp);
      throw new Error(
        `pollOperation(${opId}) HTTP ${resp.status} ${resp.statusText} :: ${detail}`,
      );
    }
    const op = (await resp.json()) as Operation;
    if (op.done) return op;

    const elapsed = nowFn() - start;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `pollOperation timeout: ${opId} still pending after ${elapsed}ms (cap=${timeoutMs}ms)`,
      );
    }

    const delay = BACKOFF_SEQ_MS[Math.min(attempt, BACKOFF_SEQ_MS.length - 1)]!;
    await sleep(delay);
    attempt++;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive solely for a backoff timer.
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}
