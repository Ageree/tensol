// Sprint 4 A14 R2 — opaque base64 cursor round-trip + rejection of garbage.

import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor } from './audit-events.ts';

describe('packages/db :: audit-events cursor (A14 R2)', () => {
  test('round-trip: encode then decode returns the same cursor', () => {
    const cursor = {
      occurredAt: '2026-04-27T12:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000001',
    };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  test('decodeCursor returns null for non-base64 input', () => {
    expect(decodeCursor('not!base64!')).toBeNull();
  });

  test('decodeCursor returns null for base64 of malformed JSON', () => {
    const garbage = Buffer.from('not json', 'utf8').toString('base64');
    expect(decodeCursor(garbage)).toBeNull();
  });

  test('decodeCursor returns null for base64 of JSON missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64');
    expect(decodeCursor(partial)).toBeNull();
  });

  test('decodeCursor returns null for empty-string fields', () => {
    const empty = Buffer.from(JSON.stringify({ occurredAt: '', id: '' }), 'utf8').toString(
      'base64',
    );
    expect(decodeCursor(empty)).toBeNull();
  });

  test('decodeCursor returns null on non-string fields', () => {
    const bad = Buffer.from(JSON.stringify({ occurredAt: 1, id: 2 }), 'utf8').toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });
});
