// T117 — Pure helpers for Dashboard "your scans" table.
//
// Extracted as a sibling module so they can be unit-tested without React.
//
//   - mapStatusToBadge(status)  — ScanOrderStatus → tone + label key
//   - formatRelativeTime(ms,now) — "5m ago" / "2h ago" / "3d ago"
//   - deriveFreeQuotaStatus(orders, now) — FR-015 quota state from scan list
//
// FR-013 / FR-015: one free Quick per rolling 7-day window. Server uses
// `users.free_quick_consumed_at < now - 168h` as the freshness test. We
// mirror the same window on the client by scanning the most recent
// `tier='quick'` scan-order (any status — server only resets on consumption).

import type { ScanOrder, ScanOrderStatus } from '../lib/api-client.ts';

// 7 days = 168 hours = 604,800,000 ms (mirrors server/free-tier/service.ts).
export const FREE_TIER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Status badge mapping ──────────────────────────────────────────────────

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted';

export interface BadgeMapping {
  readonly tone: BadgeTone;
  /** i18n key under `t.dashboard.status.*`. */
  readonly key:
    | 'draft'
    | 'provisioning'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
}

/**
 * Map a `ScanOrderStatus` (openapi.yaml) to a chip tone + a stable i18n key.
 * The provisioning bucket collapses dns_pending / dns_verified /
 * vm_provisioning since the user-visible distinction is just "not running
 * yet, but not draft either".
 */
export function mapStatusToBadge(status: ScanOrderStatus): BadgeMapping {
  switch (status) {
    case 'draft':
      return { tone: 'muted', key: 'draft' };
    case 'dns_pending':
    case 'dns_verified':
    case 'vm_provisioning':
      return { tone: 'warn', key: 'provisioning' };
    case 'running':
      return { tone: 'warn', key: 'running' };
    case 'completed':
      return { tone: 'ok', key: 'completed' };
    case 'failed':
      return { tone: 'danger', key: 'failed' };
    case 'cancelled':
      return { tone: 'muted', key: 'cancelled' };
  }
}

// ─── Per-row action button mapping ─────────────────────────────────────────

export type ActionKey = 'view' | 'resume' | 'download' | 'regenerate';

export interface ActionMapping {
  readonly key: ActionKey;
  /** Resolved against react-router; container builds final path. */
  readonly route: 'wizard-step' | 'live' | 'report';
}

export function mapStatusToAction(status: ScanOrderStatus): ActionMapping {
  switch (status) {
    case 'draft':
      return { key: 'resume', route: 'wizard-step' };
    case 'completed':
      return { key: 'download', route: 'report' };
    case 'failed':
      return { key: 'regenerate', route: 'report' };
    default:
      return { key: 'view', route: 'live' };
  }
}

// ─── Relative time formatting ──────────────────────────────────────────────

/**
 * Stable, locale-agnostic "Xm ago" / "Xh ago" / "Xd ago" formatter.
 *
 * We intentionally don't use `Intl.RelativeTimeFormat` here because the
 * dashboard table reads better with terse, monospaced units and because the
 * RU pluralization rules for "минуту/минуты/минут" would force a separate
 * dictionary — the unit suffix is just `m|h|d` for both locales.
 *
 * - `< 60s`  → `now`
 * - `< 60m`  → `Nm ago`
 * - `< 24h`  → `Nh ago`
 * - else     → `Nd ago`
 *
 * Returns `'—'` for negative deltas (clock skew on a freshly-created order).
 */
export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const deltaMs = nowMs - timestampMs;
  if (deltaMs < 0) return '—';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// ─── Free-quota status (FR-015) ────────────────────────────────────────────

export type FreeQuotaState = 'available' | 'consumed';

export interface FreeQuotaStatus {
  readonly state: FreeQuotaState;
  /**
   * When `state === 'consumed'`, this is the unix-ms timestamp when the next
   * free Quick becomes available (consumedAt + 168h). Null otherwise.
   */
  readonly resetsAtMs: number | null;
  /**
   * Convenience: days until reset, rounded UP (so "23h59m left" reads as
   * "1d"). Null when `state === 'available'`.
   */
  readonly daysUntilReset: number | null;
}

/**
 * Derive the free-quota slot state from the user's recent scan-orders.
 *
 * We treat a `tier='quick'` order with `created_at >= now - 168h` AND
 * `payment_kind === 'free_quick'` as the slot-consuming event. The server
 * also tracks `users.free_quick_consumed_at` directly; both should agree
 * within a single request window. If `/v1/auth/me` ever starts returning
 * `free_quick_consumed_at`, we can switch to that source verbatim — but
 * today the live endpoint returns only `{user:{id,email}}`, so we derive
 * from scans.
 *
 * Cancelled orders DO refund the slot server-side (per free-tier/service.ts
 * doc), but the client can't see that delta directly. Conservative
 * heuristic: ignore cancelled orders when deriving quota state.
 */
export function deriveFreeQuotaStatus(
  orders: readonly ScanOrder[],
  nowMs: number,
): FreeQuotaStatus {
  const cutoff = nowMs - FREE_TIER_WINDOW_MS;
  const consumed = orders.find(
    (o) =>
      o.tier === 'quick' &&
      o.payment_kind === 'free_quick' &&
      o.status !== 'cancelled' &&
      o.created_at >= cutoff,
  );
  if (!consumed) {
    return { state: 'available', resetsAtMs: null, daysUntilReset: null };
  }
  const resetsAtMs = consumed.created_at + FREE_TIER_WINDOW_MS;
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  const daysUntilReset = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return { state: 'consumed', resetsAtMs, daysUntilReset };
}

// ─── Sort helper ───────────────────────────────────────────────────────────

/**
 * Sort orders newest-first by `updated_at` (falls back to `created_at`).
 * Returns a NEW array — never mutates the input (immutability rule).
 */
export function sortOrdersNewestFirst(
  orders: readonly ScanOrder[],
): ScanOrder[] {
  return [...orders].sort((a, b) => {
    const aT = a.updated_at ?? a.created_at;
    const bT = b.updated_at ?? b.created_at;
    return bT - aT;
  });
}
