// T078 — Reducer unit tests. Covers state transitions only; React-hook
// integration is exercised by E2E (T090).

import { test, expect, describe } from 'bun:test';
import {
  hydrateFromOrder,
  initialWizardState,
  wizardReducer,
  type WizardState,
} from './useScanWizardState.ts';
import type { ScanOrder } from '../../lib/api-client.ts';

const seed: WizardState = { ...initialWizardState };

describe('wizardReducer', () => {
  test('stepTo advances + clears error', () => {
    const withErr = wizardReducer(seed, { type: 'error', payload: 'boom' });
    expect(withErr.error).toBe('boom');
    const next = wizardReducer(withErr, { type: 'stepTo', payload: 3 });
    expect(next.step).toBe(3);
    expect(next.error).toBeNull();
  });

  test('addHeader → setHeader → removeHeader are immutable', () => {
    const a = wizardReducer(seed, { type: 'addHeader' });
    expect(a.headers).toHaveLength(1);
    expect(seed.headers).toHaveLength(0); // original untouched

    const b = wizardReducer(a, {
      type: 'setHeader',
      index: 0,
      key: 'authorization',
      value: 'Bearer x',
    });
    expect(b.headers[0]).toEqual({ k: 'authorization', v: 'Bearer x' });
    expect(a.headers[0]).toEqual({ k: '', v: '' }); // prev frame untouched

    const c = wizardReducer(b, { type: 'removeHeader', index: 0 });
    expect(c.headers).toHaveLength(0);
  });

  test('dnsToken sets token and forces dnsVerified=false', () => {
    const verified = wizardReducer(seed, { type: 'dnsVerified' });
    expect(verified.dnsVerified).toBe(true);
    const next = wizardReducer(verified, { type: 'dnsToken', payload: 'tk_abc' });
    expect(next.dnsToken).toBe('tk_abc');
    expect(next.dnsVerified).toBe(false);
  });

  test('loaded merges partial state and clears error', () => {
    const errored = wizardReducer(seed, { type: 'error', payload: 'oops' });
    const next = wizardReducer(errored, {
      type: 'loaded',
      payload: { orderId: 'so_123', domain: 'example.com' },
    });
    expect(next.orderId).toBe('so_123');
    expect(next.domain).toBe('example.com');
    expect(next.error).toBeNull();
  });

  test('setRps replaces value', () => {
    const next = wizardReducer(seed, { type: 'setRps', payload: 12 });
    expect(next.rps).toBe(12);
  });

  test('hydrateFromOrder maps wire shape → WizardState', () => {
    const order: ScanOrder = {
      id: 'so_1',
      user_id: 'u_1',
      status: 'draft',
      tier: 'quick',
      primary_domain: 'example.com',
      attack_surface: [
        {
          domain: 'example.com',
          primary: true,
          headers: [{ k: 'authorization', v: 'Bearer x' }],
        },
        { domain: 'api.example.com', primary: false, headers: [] },
        { domain: 'admin.example.com', primary: false, headers: [] },
      ],
      safety_rps: 7,
      payment_kind: 'free_quick',
      created_at: 0,
      updated_at: 0,
      dns_verify_token: 'tk_x',
      dns_verified_at: 1700000000,
    };
    const seeded = hydrateFromOrder(order);
    expect(seeded.orderId).toBe('so_1');
    expect(seeded.domain).toBe('example.com');
    expect(seeded.subdomains).toEqual(['api.example.com', 'admin.example.com']);
    expect(seeded.headers).toEqual([{ k: 'authorization', v: 'Bearer x' }]);
    expect(seeded.rps).toBe(7);
    expect(seeded.dnsToken).toBe('tk_x');
    expect(seeded.dnsVerified).toBe(true);
  });
});
