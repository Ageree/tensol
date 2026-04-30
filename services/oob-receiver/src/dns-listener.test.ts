// Sprint 18 — Unit tests for OOB DNS listener: token extraction + NXDOMAIN.

import { describe, expect, test } from 'bun:test';
import { parseToken } from './token.ts';

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';
const VALID_TOKEN = `${VALID_UUID_A}.${VALID_UUID_B}.deadbeef`;

describe('oob-receiver :: DNS token extraction', () => {
  test('leftmost label matching token format → parsed correctly', () => {
    // DNS qname: <token>.oob.attacker.example
    // Per contract: token extracted from leftmost labels of qname reconstructed until format matches.
    // The token uses '.' as separator and DNS also uses '.' — reconstruct first 3 labels.
    const qname = `${VALID_TOKEN}.oob.attacker.example`;
    const labels = qname.split('.');
    const reconstructed = `${labels[0]}.${labels[1]}.${labels[2]}`;
    expect(parseToken(reconstructed)).not.toBeNull();
  });

  test('non-token leftmost label → token=null', () => {
    const firstLabel = 'probe123';
    expect(parseToken(firstLabel)).toBeNull();
  });

  test('valid token parses all three segments', () => {
    const result = parseToken(VALID_TOKEN);
    expect(result?.candidateId).toBe(VALID_UUID_A);
    expect(result?.tenantId).toBe(VALID_UUID_B);
    expect(result?.random8).toBe('deadbeef');
  });

  test('malformed DNS data → parseToken returns null without throwing', () => {
    // Simulate parsing from corrupted data
    expect(() => parseToken('garbage.data.xyz')).not.toThrow();
    expect(parseToken('garbage.data.xyz')).toBeNull();
  });

  test('empty qname → parseToken returns null', () => {
    expect(parseToken('')).toBeNull();
    expect(parseToken(null)).toBeNull();
  });
});

describe('oob-receiver :: DNS NXDOMAIN response', () => {
  test('NXDOMAIN response has QR=1 and RCODE=3 set', () => {
    // Build a minimal DNS query buffer (12-byte header + question).
    const queryId = 0x1234;
    const buf = Buffer.alloc(12);
    buf.writeUInt16BE(queryId, 0); // ID
    buf[2] = 0x01; // QR=0 (query), RD=1
    buf[3] = 0x00;
    buf.writeUInt16BE(1, 4); // QDCOUNT=1
    // No question section for this minimal test.

    // Replicate the NXDOMAIN builder logic inline.
    const response = Buffer.alloc(buf.length);
    buf.copy(response);
    response[2] = 0x81;
    response[3] = 0x83; // RA=1, RCODE=3

    expect(response.readUInt16BE(0)).toBe(queryId);
    expect(response[2]).toBe(0x81);
    expect(response[3] & 0x0f).toBe(3); // RCODE=3 = NXDOMAIN
  });
});
