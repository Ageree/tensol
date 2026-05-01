// Sprint 9 — artifact-writer unit tests.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalObjectStorage } from '@cyberstrike/object-storage';
import { writeArtifacts } from './artifact-writer.ts';

const mkBaseDir = (): string => mkdtempSync(path.join(tmpdir(), 'browser-worker-art-'));

const TENANT = 'tenant-12345';
const ASSESSMENT = 'assessment-67890';
const SESSION = 'session-abcdef';

describe('writeArtifacts', () => {
  test('puts 3 artefacts and returns sha256 + sizeBytes for each', async () => {
    const storage = new LocalObjectStorage({ baseDir: mkBaseDir() });
    const screenshot = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const har = new TextEncoder().encode('{"log":{"entries":[]}}');
    const trace = new Uint8Array([0x50, 0x4b]);
    const result = await writeArtifacts(storage, {
      tenantId: TENANT,
      assessmentId: ASSESSMENT,
      sessionId: SESSION,
      screenshot,
      har,
      trace,
    });
    expect(result.screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.har.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.trace.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.screenshot.sizeBytes).toBe(4);
    expect(result.har.sizeBytes).toBe(har.byteLength);
    expect(result.trace.sizeBytes).toBe(2);
  });

  test('keys obey the canonical shape and include the sha', async () => {
    const storage = new LocalObjectStorage({ baseDir: mkBaseDir() });
    const result = await writeArtifacts(storage, {
      tenantId: TENANT,
      assessmentId: ASSESSMENT,
      sessionId: SESSION,
      screenshot: new Uint8Array([1]),
      har: new Uint8Array([2]),
      trace: new Uint8Array([3]),
    });
    expect(result.screenshot.key).toContain(
      `tenant/${TENANT}/assessment/${ASSESSMENT}/browser/${SESSION}/`,
    );
    expect(result.screenshot.key.endsWith('.png')).toBe(true);
    expect(result.har.key.endsWith('.har.json')).toBe(true);
    expect(result.trace.key.endsWith('.zip')).toBe(true);
    expect(result.screenshot.key).toContain(result.screenshot.sha256);
  });

  test('rejects path-traversal-shaped ids', async () => {
    const storage = new LocalObjectStorage({ baseDir: mkBaseDir() });
    await expect(
      writeArtifacts(storage, {
        tenantId: '../etc',
        assessmentId: ASSESSMENT,
        sessionId: SESSION,
        screenshot: new Uint8Array([1]),
        har: new Uint8Array([1]),
        trace: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/unsafe_id_for_object_key/);
  });

  test('storage round-trip: get(key) bytes match sha + size', async () => {
    const storage = new LocalObjectStorage({ baseDir: mkBaseDir() });
    const screenshot = new Uint8Array([10, 20, 30, 40]);
    const result = await writeArtifacts(storage, {
      tenantId: TENANT,
      assessmentId: ASSESSMENT,
      sessionId: SESSION,
      screenshot,
      har: new TextEncoder().encode('{}'),
      trace: new Uint8Array([0]),
    });
    const loaded = await storage.get(result.screenshot.key);
    expect(loaded.byteLength).toBe(result.screenshot.sizeBytes);
    const hash = new Bun.CryptoHasher('sha256');
    hash.update(loaded);
    expect(hash.digest('hex')).toBe(result.screenshot.sha256);
  });
});
