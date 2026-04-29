// Property-based tests for normalizeIp. R8 — numRuns floor 200.

import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { fastCheckOpts } from '../test-utils/fc-opts.ts';
import { normalizeIp } from './ip.ts';

const octetArb = fc.integer({ min: 0, max: 255 });
const ipv4Arb = fc
  .tuple(octetArb, octetArb, octetArb, octetArb)
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const ipv6GroupArb = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
const ipv6Arb = fc
  .array(ipv6GroupArb, { minLength: 8, maxLength: 8 })
  .map((groups) => groups.join(':'));

describe('scope-engine :: normalize/ip — IPv4 property tests (R8 numRuns=200)', () => {
  test('idempotent', () => {
    fc.assert(
      fc.property(ipv4Arb, (raw) => {
        const a = normalizeIp(raw);
        const b = normalizeIp(a.canonical);
        return a.canonical === b.canonical && a.classification === b.classification;
      }),
      fastCheckOpts.ip,
    );
  });

  test('canonical is dotted decimal a.b.c.d', () => {
    fc.assert(
      fc.property(ipv4Arb, (raw) => {
        const r = normalizeIp(raw);
        return r.family === 'ipv4' && /^\d+\.\d+\.\d+\.\d+$/.test(r.canonical);
      }),
      fastCheckOpts.ip,
    );
  });

  test('classification is one of the closed set', () => {
    fc.assert(
      fc.property(ipv4Arb, (raw) => {
        const r = normalizeIp(raw);
        return ['public', 'private', 'loopback', 'link_local', 'metadata', 'reserved'].includes(
          r.classification,
        );
      }),
      fastCheckOpts.ip,
    );
  });
});

describe('scope-engine :: normalize/ip — IPv6 property tests (R8 numRuns=200)', () => {
  test('idempotent', () => {
    fc.assert(
      fc.property(ipv6Arb, (raw) => {
        const a = normalizeIp(raw);
        const b = normalizeIp(a.canonical);
        return a.canonical === b.canonical;
      }),
      fastCheckOpts.ip,
    );
  });

  test('canonical never contains uppercase hex', () => {
    fc.assert(
      fc.property(ipv6Arb, (raw) => {
        const r = normalizeIp(raw);
        return r.canonical === r.canonical.toLowerCase();
      }),
      fastCheckOpts.ip,
    );
  });

  test('R4 — zone-id stripped from canonical even when input had one', () => {
    fc.assert(
      fc.property(ipv6Arb, fc.stringMatching(/^[a-z]{2,5}[0-9]?$/), (raw, zone) => {
        const r = normalizeIp(`${raw}%${zone}`);
        return !r.canonical.includes('%') && r.zoneId === zone;
      }),
      fastCheckOpts.ip,
    );
  });

  test('codex iter-7 P2 — junk hex digit in any group rejects the whole IPv6', () => {
    // Generate a well-formed IPv6 (8-group full form), pick one group, append
    // a non-hex suffix. The result MUST throw rather than silently parse
    // the prefix as the group's value.
    const junkArb = fc
      .tuple(ipv6Arb, fc.integer({ min: 0, max: 7 }), fc.constantFrom('z', 'q', 'g', '!'))
      .map(([raw, idx, suffix]) => {
        const groups = raw.split(':');
        groups[idx] = `${groups[idx] ?? '0'}${suffix}`;
        return groups.join(':');
      });
    fc.assert(
      fc.property(junkArb, (junk) => {
        try {
          normalizeIp(junk);
          return false; // accepted junk → property violated
        } catch {
          return true;
        }
      }),
      fastCheckOpts.ip,
    );
  });
});
