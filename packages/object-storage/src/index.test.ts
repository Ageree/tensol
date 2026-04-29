// Sprint 8 — LocalObjectStorage round-trip + safety tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalObjectStorage, name } from './index.ts';

describe('packages/object-storage :: smoke', () => {
  test('name equals workspace key', () => {
    expect(name).toBe('packages/object-storage');
  });
});

describe('LocalObjectStorage', () => {
  let baseDir: string;
  let storage: LocalObjectStorage;

  beforeAll(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'cs-objstore-'));
    storage = new LocalObjectStorage({ baseDir });
  });
  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test('put returns sha256 + size + key; get round-trips the bytes', async () => {
    const body = JSON.stringify({ a: 1, b: 'hello' });
    const result = await storage.put({
      key: 'tenant/abc/assessment/xyz/opplan-1.json',
      body,
      contentType: 'application/json',
    });
    expect(result.key).toBe('tenant/abc/assessment/xyz/opplan-1.json');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBe(body.length);
    const back = await storage.get(result.key);
    expect(back.toString('utf8')).toBe(body);
  });

  test('rejects keys with `..` (path traversal guard)', async () => {
    await expect(
      storage.put({ key: 'tenant/abc/../etc/passwd', body: 'x', contentType: 'text/plain' }),
    ).rejects.toThrow(/unsafe_object_key/);
    await expect(storage.get('tenant/abc/../etc/passwd')).rejects.toThrow(/unsafe_object_key/);
  });

  test('rejects keys with invalid chars', async () => {
    await expect(
      storage.put({ key: ' bad key', body: 'x', contentType: 'text/plain' }),
    ).rejects.toThrow(/unsafe_object_key/);
  });

  test('sha256 is deterministic for identical bodies', async () => {
    const r1 = await storage.put({
      key: 'tenant/abc/assessment/xyz/file-a.bin',
      body: 'identical-bytes',
      contentType: 'application/octet-stream',
    });
    const r2 = await storage.put({
      key: 'tenant/abc/assessment/xyz/file-b.bin',
      body: 'identical-bytes',
      contentType: 'application/octet-stream',
    });
    expect(r1.sha256).toBe(r2.sha256);
  });

  test('sha256 differs for different bodies', async () => {
    const r1 = await storage.put({
      key: 'tenant/abc/assessment/xyz/diff-1.bin',
      body: 'a',
      contentType: 'application/octet-stream',
    });
    const r2 = await storage.put({
      key: 'tenant/abc/assessment/xyz/diff-2.bin',
      body: 'b',
      contentType: 'application/octet-stream',
    });
    expect(r1.sha256).not.toBe(r2.sha256);
  });
});
