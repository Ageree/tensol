import { describe, expect, test } from 'bun:test';
import { SessionRepo } from './session-repo.ts';

describe('apps/api :: SessionRepo cookie format (C20)', () => {
  test('formatCookieValue produces `userId.plaintext`', () => {
    const v = SessionRepo.formatCookieValue('00000000-0000-0000-0000-000000000001', 'a'.repeat(64));
    expect(v).toBe(`00000000-0000-0000-0000-000000000001.${'a'.repeat(64)}`);
  });

  test('parseCookieValue round-trips a well-formed cookie', () => {
    const v = SessionRepo.formatCookieValue('00000000-0000-0000-0000-000000000001', 'b'.repeat(64));
    const parsed = SessionRepo.parseCookieValue(v);
    expect(parsed).toEqual({
      userId: '00000000-0000-0000-0000-000000000001',
      plaintext: 'b'.repeat(64),
    });
  });

  test('parseCookieValue rejects malformed inputs', () => {
    expect(SessionRepo.parseCookieValue('')).toBeNull();
    expect(SessionRepo.parseCookieValue('garbage')).toBeNull();
    // No dot.
    expect(SessionRepo.parseCookieValue(`a${'b'.repeat(63)}`)).toBeNull();
    // Bad UUID prefix.
    expect(SessionRepo.parseCookieValue(`not-a-uuid.${'a'.repeat(64)}`)).toBeNull();
    // Plaintext wrong length.
    expect(SessionRepo.parseCookieValue('00000000-0000-0000-0000-000000000001.short')).toBeNull();
    // Plaintext non-hex.
    expect(
      SessionRepo.parseCookieValue(`00000000-0000-0000-0000-000000000001.${'g'.repeat(64)}`),
    ).toBeNull();
  });
});
