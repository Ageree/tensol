// EE-3.A (2026-05-12) — unit tests for createYandexClient.
//
// Mirrors hetzner-client.test.ts structure with Yandex Compute Cloud
// REST API semantics.

import { describe, expect, it } from 'bun:test';
import { ScanError } from '../types.ts';
import { createYandexClient } from '../yandex-client.ts';
import type { YandexCreateInstanceOpts } from '../yandex-types.ts';

const baseCreateOpts: YandexCreateInstanceOpts = {
  folderId: 'b1g1234567890abcdef',
  name: 'tensol-scan-abc',
  zoneId: 'ru-central1-a',
  platformId: 'standard-v3',
  resourcesSpec: {
    memoryBytes: 2 * 1024 * 1024 * 1024,
    cores: 2,
    coreFraction: 100,
  },
  imageId: 'fd87dvmlb1234567890',
  bootDiskBytes: 20 * 1024 * 1024 * 1024,
  subnetId: 'e9bn456789abcdef0',
  userData: '#cloud-config\npackages:\n  - docker.io\n',
  labels: { scan_id: 'abc', managed_by: 'tensol' },
};

const okOperation = (overrides: object = {}) => ({
  id: 'op-12345',
  description: 'Create instance tensol-scan-abc',
  done: false,
  metadata: { instanceId: 'i-67890' },
  ...overrides,
});

const okInstance = (overrides: object = {}) => ({
  id: 'i-67890',
  folderId: 'b1g1234567890abcdef',
  status: 'RUNNING' as const,
  networkInterfaces: [
    {
      primaryV4Address: {
        address: '10.0.0.5',
        oneToOneNat: { address: '51.250.42.10' },
      },
    },
  ],
  createdAt: '2026-05-12T10:00:00Z',
  ...overrides,
});

const mockFetch = (status: number, body: unknown): typeof globalThis.fetch =>
  (async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

describe('createYandexClient', () => {
  describe('createInstance', () => {
    it('happy path → serializes Yandex body, returns instance + operation', async () => {
      let capturedInit: RequestInit | undefined;
      let capturedUrl: string | undefined;
      const fetch: typeof globalThis.fetch = async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify(okOperation()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = createYandexClient({ iamToken: 't1.iam.token', fetch });
      const result = await client.createInstance(baseCreateOpts);

      expect(result.instance.id).toBe('i-67890');
      expect(result.instance.status).toBe('PROVISIONING');
      expect(result.instance.externalIpv4).toEqual([]);
      expect(result.operation.id).toBe('op-12345');

      expect(capturedUrl).toContain('/compute/v1/instances');
      expect(capturedInit?.method).toBe('POST');

      const body = JSON.parse(capturedInit?.body as string);
      expect(body.folderId).toBe('b1g1234567890abcdef');
      expect(body.name).toBe('tensol-scan-abc');
      expect(body.zoneId).toBe('ru-central1-a');
      expect(body.platformId).toBe('standard-v3');
      expect(body.resourcesSpec).toEqual({
        memory: String(2 * 1024 * 1024 * 1024),
        cores: '2',
        coreFraction: '100',
      });
      expect(body.bootDiskSpec.diskSpec.imageId).toBe('fd87dvmlb1234567890');
      expect(body.bootDiskSpec.diskSpec.size).toBe(String(20 * 1024 * 1024 * 1024));
      expect(body.networkInterfaceSpecs[0].subnetId).toBe('e9bn456789abcdef0');
      expect(body.networkInterfaceSpecs[0].primaryV4AddressSpec.oneToOneNatSpec.ipVersion).toBe(
        'IPV4',
      );
      expect(body.metadata['user-data']).toBe(baseCreateOpts.userData);
      expect(body.labels).toEqual({ scan_id: 'abc', managed_by: 'tensol' });

      expect(capturedInit?.headers).toMatchObject({ Authorization: 'Bearer t1.iam.token' });
    });

    it('operation without instanceId → ScanError{code:create_failed}', async () => {
      const opWithoutId = { ...okOperation(), metadata: {} };
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(200, opWithoutId),
      });
      await expect(client.createInstance(baseCreateOpts)).rejects.toMatchObject({
        code: 'create_failed',
      });
    });

    it('401 → ScanError{invalid_request}', async () => {
      const client = createYandexClient({
        iamToken: 'bad',
        fetch: mockFetch(401, { error: 'unauthorized' }),
      });
      await expect(client.createInstance(baseCreateOpts)).rejects.toBeInstanceOf(ScanError);
      await expect(client.createInstance(baseCreateOpts)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    });

    it('400 → ScanError{invalid_request}', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(400, { error: 'bad input' }),
      });
      await expect(client.createInstance(baseCreateOpts)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    });

    it('5xx → throws non-ScanError (retryable)', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(503, { error: 'service unavailable' }),
      });
      await expect(client.createInstance(baseCreateOpts)).rejects.toThrow(/Yandex 503/);
      const err = await client.createInstance(baseCreateOpts).catch((e) => e);
      expect(err).not.toBeInstanceOf(ScanError);
    });
  });

  describe('getInstance', () => {
    it('happy path → maps externalIpv4 from NIC oneToOneNat', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(200, okInstance()),
      });
      const ins = await client.getInstance('i-67890');
      expect(ins.id).toBe('i-67890');
      expect(ins.status).toBe('RUNNING');
      expect(ins.externalIpv4).toEqual(['51.250.42.10']);
    });

    it('PROVISIONING with no NIC yet → externalIpv4 empty', async () => {
      const provisioning = okInstance({
        status: 'PROVISIONING',
        networkInterfaces: [{ primaryV4Address: { address: '10.0.0.5' } }],
      });
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(200, provisioning),
      });
      const ins = await client.getInstance('i-67890');
      expect(ins.status).toBe('PROVISIONING');
      expect(ins.externalIpv4).toEqual([]);
    });

    it('404 → ScanError{invalid_request}', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(404, { error: 'not found' }),
      });
      await expect(client.getInstance('missing')).rejects.toMatchObject({
        code: 'invalid_request',
      });
    });
  });

  describe('deleteInstance', () => {
    it('happy path → returns operation, hits DELETE method', async () => {
      let capturedMethod: string | undefined;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        capturedMethod = init?.method;
        return new Response(JSON.stringify({ id: 'op-del', done: false, description: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      const client = createYandexClient({ iamToken: 't', fetch });
      const op = await client.deleteInstance('i-67890');
      expect(capturedMethod).toBe('DELETE');
      expect(op.id).toBe('op-del');
      expect(op.done).toBe(false);
    });
  });

  describe('getOperation', () => {
    it('happy path → returns done with error null', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(200, { id: 'op-1', done: true, description: 'Create instance' }),
      });
      const op = await client.getOperation('op-1');
      expect(op.done).toBe(true);
      expect(op.error).toBeUndefined();
    });

    it('operation done with error → preserves error envelope', async () => {
      const client = createYandexClient({
        iamToken: 't',
        fetch: mockFetch(200, {
          id: 'op-2',
          done: true,
          description: '',
          error: { code: 9, message: 'quota exceeded' },
        }),
      });
      const op = await client.getOperation('op-2');
      expect(op.done).toBe(true);
      expect(op.error).toEqual({ code: 9, message: 'quota exceeded' });
    });
  });
});
