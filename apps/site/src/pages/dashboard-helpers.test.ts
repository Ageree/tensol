// T117 — Unit tests for Dashboard helpers (pure logic, no React).

import { describe, expect, it } from 'bun:test';
import type { ScanOrder, ScanOrderStatus } from '../lib/api-client.ts';
import {
  deriveFreeQuotaStatus,
  formatRelativeTime,
  FREE_TIER_WINDOW_MS,
  mapStatusToAction,
  mapStatusToBadge,
  sortOrdersNewestFirst,
} from './dashboard-helpers.ts';

function order(over: Partial<ScanOrder>): ScanOrder {
  return {
    id: 'so_1',
    user_id: 'u_1',
    status: 'draft',
    tier: 'quick',
    primary_domain: 'example.com',
    attack_surface: [],
    safety_rps: 2,
    payment_kind: 'free_quick',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  };
}

describe('mapStatusToBadge', () => {
  const cases: Array<[ScanOrderStatus, string, string]> = [
    ['draft', 'muted', 'draft'],
    ['dns_pending', 'warn', 'provisioning'],
    ['dns_verified', 'warn', 'provisioning'],
    ['vm_provisioning', 'warn', 'provisioning'],
    ['running', 'warn', 'running'],
    ['completed', 'ok', 'completed'],
    ['failed', 'danger', 'failed'],
    ['cancelled', 'muted', 'cancelled'],
  ];
  for (const [status, tone, key] of cases) {
    it(`maps ${status} → ${tone}/${key}`, () => {
      const b = mapStatusToBadge(status);
      expect(b.tone).toBe(tone as never);
      expect(b.key).toBe(key as never);
    });
  }
});

describe('mapStatusToAction', () => {
  it('draft → resume / wizard-step', () => {
    expect(mapStatusToAction('draft')).toEqual({
      key: 'resume',
      route: 'wizard-step',
    });
  });
  it('completed → download / report', () => {
    expect(mapStatusToAction('completed')).toEqual({
      key: 'download',
      route: 'report',
    });
  });
  it('failed → regenerate / report', () => {
    expect(mapStatusToAction('failed')).toEqual({
      key: 'regenerate',
      route: 'report',
    });
  });
  it('running → view / live', () => {
    expect(mapStatusToAction('running')).toEqual({ key: 'view', route: 'live' });
  });
  it('cancelled → view / live (no action other than inspect)', () => {
    expect(mapStatusToAction('cancelled')).toEqual({
      key: 'view',
      route: 'live',
    });
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;
  it('< 60s returns "now"', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('now');
  });
  it('minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('hours', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });
  it('days', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
  it('negative delta → em dash (clock-skew safe)', () => {
    expect(formatRelativeTime(now + 1000, now)).toBe('—');
  });
});

describe('deriveFreeQuotaStatus', () => {
  const now = 2_000_000_000_000;

  it('no orders → available', () => {
    const q = deriveFreeQuotaStatus([], now);
    expect(q.state).toBe('available');
    expect(q.resetsAtMs).toBeNull();
    expect(q.daysUntilReset).toBeNull();
  });

  it('fresh free_quick within 7d → consumed', () => {
    const created = now - 2 * 24 * 60 * 60 * 1000; // 2d ago
    const q = deriveFreeQuotaStatus(
      [order({ created_at: created, payment_kind: 'free_quick', status: 'running' })],
      now,
    );
    expect(q.state).toBe('consumed');
    expect(q.resetsAtMs).toBe(created + FREE_TIER_WINDOW_MS);
    expect(q.daysUntilReset).toBe(5);
  });

  it('free_quick older than 7d → available again', () => {
    const created = now - 10 * 24 * 60 * 60 * 1000; // 10d ago
    const q = deriveFreeQuotaStatus(
      [order({ created_at: created, payment_kind: 'free_quick', status: 'completed' })],
      now,
    );
    expect(q.state).toBe('available');
  });

  it('cancelled free_quick is refunded → available', () => {
    const created = now - 1 * 24 * 60 * 60 * 1000;
    const q = deriveFreeQuotaStatus(
      [order({ created_at: created, payment_kind: 'free_quick', status: 'cancelled' })],
      now,
    );
    expect(q.state).toBe('available');
  });

  it('paid yookassa order does not consume free quota', () => {
    const q = deriveFreeQuotaStatus(
      [order({ payment_kind: 'yookassa', status: 'running' })],
      now,
    );
    expect(q.state).toBe('available');
  });

  it('daysUntilReset rounds up (23h left = 1d)', () => {
    const created = now - (FREE_TIER_WINDOW_MS - 60 * 60 * 1000); // 23h until reset
    const q = deriveFreeQuotaStatus(
      [order({ created_at: created, payment_kind: 'free_quick', status: 'running' })],
      now,
    );
    expect(q.daysUntilReset).toBe(1);
  });
});

describe('sortOrdersNewestFirst', () => {
  it('sorts by updated_at desc, falling back to created_at', () => {
    const a = order({ id: 'a', updated_at: 100, created_at: 100 });
    const b = order({ id: 'b', updated_at: 300, created_at: 200 });
    const c = order({ id: 'c', updated_at: 200, created_at: 200 });
    const sorted = sortOrdersNewestFirst([a, b, c]);
    expect(sorted.map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate the input', () => {
    const a = order({ id: 'a', updated_at: 100 });
    const b = order({ id: 'b', updated_at: 200 });
    const input = [a, b] as const;
    sortOrdersNewestFirst(input);
    expect(input[0]?.id).toBe('a');
    expect(input[1]?.id).toBe('b');
  });
});
