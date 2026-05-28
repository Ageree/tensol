// T081 — Pure helpers used by Step3DnsVerify.tsx.
//
// Kept in their own module so the polling stop-predicate + countdown
// formatter are unit-testable without rendering React. The component
// imports `dnsVerifyShouldStop` as a stable identity (avoids recreating
// `usePolling`'s poller on every render — see `usePolling` referential
// stability note in apps/site/src/lib/poll.ts).
//
// Constitution V (NON-NEGOTIABLE): DNS verification uses polling, not SSE.

import type { DnsVerifyCheckResult } from '../../lib/api-client.ts';

/** TTL of the DNS-verify window per FR-008 / openapi.yaml (30 minutes). */
export const DNS_VERIFY_WINDOW_SECONDS = 30 * 60;

/** Polling cadence per task brief (T081 — every 5 seconds). */
export const DNS_VERIFY_POLL_INTERVAL_MS = 5_000;

/** After this many seconds of no-progress, surface the "contact support" CTA. */
export const DNS_VERIFY_STALL_HINT_SECONDS = 10 * 60;

/**
 * Stop predicate for `usePolling`. The poller halts when the server reports
 * either a successful verification OR the verification window has elapsed.
 *
 * Keep the implementation total (no throws) — `usePolling.stopWhen` is
 * called from a setTimeout chain and a throw would leak through the
 * scheduler's `.then`.
 */
export function dnsVerifyShouldStop(result: DnsVerifyCheckResult): boolean {
  if (result.verified) return true;
  if (
    typeof result.remaining_window_seconds === 'number' &&
    result.remaining_window_seconds <= 0
  ) {
    return true;
  }
  return false;
}

/**
 * Format a non-negative second count as `mm:ss`. Clamps negatives to 0 and
 * NaN/Infinity to 0 — the UI never wants to render "−01:34" or "NaN:NaN".
 *
 * Examples:
 *   formatCountdown(1800) === "30:00"
 *   formatCountdown(59)   === "00:59"
 *   formatCountdown(-7)   === "00:00"
 *   formatCountdown(NaN)  === "00:00"
 */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(mm)}:${pad(ss)}`;
}

/**
 * Should the UI show the "contact support" CTA? Triggers when the
 * verification window has been open longer than `DNS_VERIFY_STALL_HINT_SECONDS`
 * (default 10 minutes — task brief: "after ~10 minutes of stall"). Computed
 * from `remaining_window_seconds`, which the server returns in every check.
 */
export function shouldShowStallHint(
  remainingSeconds: number,
): boolean {
  if (!Number.isFinite(remainingSeconds)) return false;
  const elapsed = DNS_VERIFY_WINDOW_SECONDS - remainingSeconds;
  return elapsed >= DNS_VERIFY_STALL_HINT_SECONDS && remainingSeconds > 0;
}

/** Telegram fallback handle (founder direct) per project memory. */
export const SUPPORT_TELEGRAM_URL = 'https://t.me/kapital0';
