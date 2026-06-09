// T079 + T080 — unit tests for the pure helpers backing Step 1/2 client
// validation. React-side behavior is exercised by E2E (T090); these tests
// only lock down the regex + clamp invariants that the container also
// imports.

import { describe, expect, test } from 'bun:test';
import { isValidHostname } from './Step1AttackSurface.tsx';
import {
  clampRps,
  isValidRps,
  RPS_MAX,
  RPS_MIN,
  RPS_PRESETS,
} from './Step2Safety.tsx';

describe('isValidHostname', () => {
  test('accepts public lowercase RFC 1035 hostnames', () => {
    expect(isValidHostname('example.com')).toBe(true);
    expect(isValidHostname('api.example.com')).toBe(true);
    expect(isValidHostname('a-1.b-2.c-3.example.io')).toBe(true);
  });

  test('rejects empty / too-long / uppercase / schemed / non-public targets', () => {
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('Example.com')).toBe(false);
    expect(isValidHostname('https://example.com')).toBe(false);
    expect(isValidHostname('example.com.')).toBe(false);
    expect(isValidHostname('-bad.example.com')).toBe(false);
    expect(isValidHostname('bad-.example.com')).toBe(false);
    expect(isValidHostname('single')).toBe(false);
    expect(isValidHostname('localhost')).toBe(false);
    expect(isValidHostname('127.0.0.1')).toBe(false);
    expect(isValidHostname('example.123')).toBe(false);
    expect(isValidHostname('a'.repeat(254))).toBe(false);
  });
});

describe('clampRps', () => {
  test('clamps below RPS_MIN to RPS_MIN', () => {
    expect(clampRps(0)).toBe(RPS_MIN);
    expect(clampRps(-5)).toBe(RPS_MIN);
  });
  test('clamps above RPS_MAX to RPS_MAX', () => {
    expect(clampRps(501)).toBe(RPS_MAX);
    expect(clampRps(9999)).toBe(RPS_MAX);
  });
  test('rounds non-integers', () => {
    expect(clampRps(50.4)).toBe(50);
    expect(clampRps(50.6)).toBe(51);
  });
  test('non-finite → RPS_MIN (safe fallback)', () => {
    expect(clampRps(Number.NaN)).toBe(RPS_MIN);
    expect(clampRps(Number.POSITIVE_INFINITY)).toBe(RPS_MIN);
    expect(clampRps(Number.NEGATIVE_INFINITY)).toBe(RPS_MIN);
  });
});

describe('isValidRps', () => {
  test('accepts integers in [1, 500]', () => {
    expect(isValidRps(1)).toBe(true);
    expect(isValidRps(50)).toBe(true);
    expect(isValidRps(500)).toBe(true);
  });
  test('rejects out-of-range or non-integer', () => {
    expect(isValidRps(0)).toBe(false);
    expect(isValidRps(501)).toBe(false);
    expect(isValidRps(50.5)).toBe(false);
    expect(isValidRps(Number.NaN)).toBe(false);
  });
});

describe('RPS_PRESETS', () => {
  test('three chips with Safe=10, Default=50, Aggressive=200', () => {
    expect(RPS_PRESETS.length).toBe(3);
    const map = Object.fromEntries(RPS_PRESETS.map((p) => [p.key, p.value]));
    expect(map.safe).toBe(10);
    expect(map.default).toBe(50);
    expect(map.aggressive).toBe(200);
  });
});
