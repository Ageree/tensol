// Sprint 18 — Unit tests for OOB HTTP listener: token parsing + header redaction.

import { describe, expect, test } from 'bun:test';
import { redactHeaders } from './redact.ts';
import { extractTokenFromPath, parseToken } from './token.ts';

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';
const VALID_TOKEN = `${VALID_UUID_A}.${VALID_UUID_B}.deadbeef`;

describe('oob-receiver :: token parsing', () => {
  test('valid token → all segments extracted', () => {
    const result = parseToken(VALID_TOKEN);
    expect(result).not.toBeNull();
    expect(result?.candidateId).toBe(VALID_UUID_A);
    expect(result?.tenantId).toBe(VALID_UUID_B);
    expect(result?.random8).toBe('deadbeef');
  });

  test('invalid format (only 2 parts) → null', () => {
    expect(parseToken(`${VALID_UUID_A}.${VALID_UUID_B}`)).toBeNull();
  });

  test('invalid uuid in first segment → null', () => {
    expect(parseToken(`not-a-uuid.${VALID_UUID_B}.deadbeef`)).toBeNull();
  });

  test('invalid random8 (too short) → null', () => {
    expect(parseToken(`${VALID_UUID_A}.${VALID_UUID_B}.abc`)).toBeNull();
  });

  test('missing/null token → null', () => {
    expect(parseToken(null)).toBeNull();
    expect(parseToken(undefined)).toBeNull();
    expect(parseToken('')).toBeNull();
  });

  test('extractTokenFromPath: prefers query param over path', () => {
    const result = extractTokenFromPath('/some/path', VALID_TOKEN);
    expect(result).toBe(VALID_TOKEN);
  });

  test('extractTokenFromPath: falls back to path segment', () => {
    const result = extractTokenFromPath(`/${VALID_TOKEN}/callback`, null);
    expect(result).toBe(VALID_TOKEN);
  });

  test('extractTokenFromPath: no token anywhere → null', () => {
    expect(extractTokenFromPath('/no/token/here', null)).toBeNull();
  });
});

describe('oob-receiver :: header redaction', () => {
  test('Authorization value replaced with [REDACTED]', () => {
    const result = redactHeaders({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
    });
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  test('Cookie value replaced with [REDACTED]', () => {
    const result = redactHeaders({ cookie: 'session=abc123', 'x-custom': 'value' });
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['x-custom']).toBe('value');
  });

  test('case-insensitive redaction for Authorization', () => {
    const result = redactHeaders({ authorization: 'token xyz', AUTHORIZATION: 'other' });
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.AUTHORIZATION).toBe('[REDACTED]');
  });

  test('non-sensitive headers pass through unchanged', () => {
    const headers = { 'x-forwarded-for': '1.2.3.4', accept: '*/*' };
    expect(redactHeaders(headers)).toEqual(headers);
  });
});
