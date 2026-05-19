// T081 — unit tests for the pure helpers behind Step 3 DNS verify polling.
//
// Component behavior (rendering, polling cadence, button labels) is covered
// by E2E (T090). These tests only lock down the stop-predicate, countdown
// formatter, and stall-hint trigger that drive `usePolling`.

import { describe, expect, test } from 'bun:test';
import {
  DNS_VERIFY_STALL_HINT_SECONDS,
  DNS_VERIFY_WINDOW_SECONDS,
  dnsVerifyShouldStop,
  formatCountdown,
  shouldShowStallHint,
} from './dns-verify-helpers.ts';

describe('dnsVerifyShouldStop', () => {
  test('stops when verified=true', () => {
    expect(
      dnsVerifyShouldStop({
        verified: true,
        attempts: 1,
        remaining_window_seconds: 1700,
      }),
    ).toBe(true);
  });

  test('stops when the window has elapsed (remaining ≤ 0)', () => {
    expect(
      dnsVerifyShouldStop({
        verified: false,
        attempts: 360,
        remaining_window_seconds: 0,
      }),
    ).toBe(true);
    expect(
      dnsVerifyShouldStop({
        verified: false,
        attempts: 360,
        remaining_window_seconds: -3,
      }),
    ).toBe(true);
  });

  test('continues while not verified and window remains', () => {
    expect(
      dnsVerifyShouldStop({
        verified: false,
        attempts: 5,
        remaining_window_seconds: 1500,
      }),
    ).toBe(false);
  });

  test('passes through last_error without stopping', () => {
    expect(
      dnsVerifyShouldStop({
        verified: false,
        attempts: 2,
        remaining_window_seconds: 1700,
        last_error: 'NXDOMAIN',
      }),
    ).toBe(false);
  });
});

describe('formatCountdown', () => {
  test('formats whole minutes', () => {
    expect(formatCountdown(DNS_VERIFY_WINDOW_SECONDS)).toBe('30:00');
    expect(formatCountdown(60)).toBe('01:00');
  });

  test('pads single-digit seconds', () => {
    expect(formatCountdown(59)).toBe('00:59');
    expect(formatCountdown(125)).toBe('02:05');
  });

  test('clamps negative / non-finite to 00:00', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-7)).toBe('00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00');
  });

  test('floors fractional seconds (poller round-trip jitter)', () => {
    expect(formatCountdown(59.9)).toBe('00:59');
    expect(formatCountdown(60.4)).toBe('01:00');
  });
});

describe('shouldShowStallHint', () => {
  test('false when fresh window', () => {
    expect(shouldShowStallHint(DNS_VERIFY_WINDOW_SECONDS)).toBe(false);
  });

  test('true after stall threshold elapsed', () => {
    const after10min =
      DNS_VERIFY_WINDOW_SECONDS - DNS_VERIFY_STALL_HINT_SECONDS;
    expect(shouldShowStallHint(after10min)).toBe(true);
    expect(shouldShowStallHint(after10min - 30)).toBe(true);
  });

  test('false once the window has expired (poller has already stopped)', () => {
    expect(shouldShowStallHint(0)).toBe(false);
    expect(shouldShowStallHint(-1)).toBe(false);
  });

  test('false on non-finite remaining seconds', () => {
    expect(shouldShowStallHint(Number.NaN)).toBe(false);
  });
});
