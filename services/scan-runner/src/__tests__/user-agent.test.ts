import { describe, expect, it } from 'bun:test';
import { ScanError } from '../types.ts';
import { buildUserAgent } from '../user-agent.ts';

describe('buildUserAgent', () => {
  it('returns correct header for valid uuid', () => {
    const scanId = '550e8400-e29b-41d4-a716-446655440000';
    expect(buildUserAgent({ scanId })).toBe(`Tensol-Scan/${scanId}`);
  });

  it('returns correct header for alphanumeric scanId', () => {
    expect(buildUserAgent({ scanId: 'abc123' })).toBe('Tensol-Scan/abc123');
  });

  it('returns correct header for scanId with dashes and underscores', () => {
    expect(buildUserAgent({ scanId: 'scan_id-123' })).toBe('Tensol-Scan/scan_id-123');
  });

  it('throws ScanError for empty string', () => {
    expect(() => buildUserAgent({ scanId: '' })).toThrow(ScanError);
    try {
      buildUserAgent({ scanId: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(ScanError);
      expect((err as ScanError).code).toBe('invalid_request');
    }
  });

  it('throws ScanError for scanId containing \\r\\n (header injection guard)', () => {
    expect(() => buildUserAgent({ scanId: 'abc\r\nX-Injected: evil' })).toThrow(ScanError);
    try {
      buildUserAgent({ scanId: 'abc\r\nX-Injected: evil' });
    } catch (err) {
      expect((err as ScanError).code).toBe('invalid_request');
    }
  });

  it('throws ScanError for scanId containing spaces', () => {
    expect(() => buildUserAgent({ scanId: 'has space' })).toThrow(ScanError);
    try {
      buildUserAgent({ scanId: 'has space' });
    } catch (err) {
      expect((err as ScanError).code).toBe('invalid_request');
    }
  });

  it('throws ScanError for scanId containing special chars', () => {
    expect(() => buildUserAgent({ scanId: 'abc<script>' })).toThrow(ScanError);
  });
});
