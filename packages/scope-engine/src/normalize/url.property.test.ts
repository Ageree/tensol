// Property-based tests for normalizeUrl. R8 — numRuns floor 1000.

import { describe, test } from 'bun:test';
import fc from 'fast-check';
import { fastCheckOpts } from '../test-utils/fc-opts.ts';
import { normalizeUrl } from './url.ts';

const schemeArb = fc.constantFrom('http', 'https', 'HTTP', 'HTTPS', 'Https');

const labelArb = fc.stringMatching(/^[a-z]{1,8}$/);
const hostArb = fc
  .array(labelArb, { minLength: 2, maxLength: 4 })
  .map((labels) => labels.join('.'));

const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { freq: 3 });

const segmentArb = fc.stringMatching(/^[a-z]{1,5}$/);
const pathArb = fc
  .array(segmentArb, { minLength: 0, maxLength: 6 })
  .map((segs) => `/${segs.join('/')}`);

const queryArb = fc.option(fc.stringMatching(/^[a-z]=[a-z0-9]{1,4}$/), { freq: 4 });
const fragmentArb = fc.option(fc.stringMatching(/^[a-z]{1,5}$/), { freq: 4 });

const urlArb = fc
  .tuple(schemeArb, hostArb, portArb, pathArb, queryArb, fragmentArb)
  .map(([scheme, host, port, path, q, frag]) => {
    const portStr = port == null ? '' : `:${port}`;
    const qs = q == null ? '' : `?${q}`;
    const fr = frag == null ? '' : `#${frag}`;
    return `${scheme}://${host}${portStr}${path}${qs}${fr}`;
  });

describe('scope-engine :: normalize/url — property tests (R8 numRuns=1000)', () => {
  test('idempotent: normalizeUrl(normalizeUrl(u)) === normalizeUrl(u)', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const a = normalizeUrl(raw);
        const b = normalizeUrl(a.canonical);
        return a.canonical === b.canonical;
      }),
      fastCheckOpts.url,
    );
  });

  test('canonical starts with lowercase scheme://', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const r = normalizeUrl(raw);
        return r.canonical.startsWith(`${r.scheme}://`) && r.scheme === r.scheme.toLowerCase();
      }),
      fastCheckOpts.url,
    );
  });

  test('hostname is ASCII-LDH after normalization', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const r = normalizeUrl(raw);
        return /^[a-z0-9.-]+$/.test(r.host);
      }),
      fastCheckOpts.url,
    );
  });

  test('default port elided', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const r = normalizeUrl(raw);
        if (r.scheme === 'http' && r.port === 80) return false;
        if (r.scheme === 'https' && r.port === 443) return false;
        return true;
      }),
      fastCheckOpts.url,
    );
  });

  test('no `..` segment in normalized path', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const r = normalizeUrl(raw);
        return !r.path.split('/').includes('..');
      }),
      fastCheckOpts.url,
    );
  });

  test('canonical never contains a fragment', () => {
    fc.assert(
      fc.property(urlArb, (raw) => {
        const r = normalizeUrl(raw);
        return !r.canonical.includes('#');
      }),
      fastCheckOpts.url,
    );
  });

  test('codex iter-8 P1 — `/admin` encoded in lowercase-hex forms decodes to literal /admin in normalized path', () => {
    // Inputs that ALL spell `admin` in their decoded form. Decoding is
    // case-preserving per RFC 3986 (%61=a, not A). Each fixture is exactly
    // 5 characters' worth of `admin` after decoding, with one or more
    // characters replaced by their lowercase-decoding %xx form. No fixture
    // contains a literal duplicate letter alongside its encoded version.
    const encodedAdminPathArb = fc.constantFrom(
      '/admin',
      '/%61dmin', // %61=a
      '/a%64min', // %64=d
      '/ad%6din', // %6d=m
      '/adm%69n', // %69=i
      '/admi%6e', // %6e=n
      '/%61%64%6d%69%6e', // fully encoded lowercase
    );
    const urlWithEncodedAdminArb = fc
      .tuple(schemeArb, hostArb, encodedAdminPathArb)
      .map(([scheme, host, path]) => `${scheme.toLowerCase()}://${host}${path}`);
    fc.assert(
      fc.property(urlWithEncodedAdminArb, (raw) => {
        const r = normalizeUrl(raw);
        return r.path.includes('/admin');
      }),
      fastCheckOpts.url,
    );
  });
});
