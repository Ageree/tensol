// EE-3.A (2026-05-12) — Yandex Cloud Compute REST API client.
//
// Mirrors createHetznerClient in role: thin wrapper around fetch that issues
// create/get/delete instance calls with proper auth, schema-validates the
// response, and maps Yandex errors into ScanError (so the upper-layer
// scan-runner.ts can react identically regardless of provider).
//
// Auth: short-lived IAM token (12h). The caller is responsible for refresh
// — typically via a sidecar that exchanges a service-account JSON key for
// IAM tokens hourly. See Yandex docs:
// https://yandex.cloud/en/docs/iam/api-ref/IamToken/create
//
// Differences from hetzner-client.ts:
//   - 401/403 → invalid_request (same as Hetzner)
//   - 429 → throw Error (retryable) — same shape
//   - Yandex returns CREATED-201, not 200, on instance create
//   - Instance create response contains both the instance row AND the
//     operation that creates it (long-running). Caller polls getInstance
//     for status transitions, NOT getOperation.

import { z } from 'zod';
import { ScanError } from './types.ts';
import {
  type YandexComputeClient,
  type YandexComputeClientDeps,
  type YandexCreateInstanceOpts,
  type YandexInstance,
  type YandexOperation,
  yandexInstanceSchema,
  yandexOperationSchema,
} from './yandex-types.ts';

const DEFAULT_BASE_URL = 'https://compute.api.cloud.yandex.net/compute/v1';

const createInstanceResponseSchema = yandexOperationSchema.extend({
  // Compute API returns the full operation envelope; the "metadata" carries
  // the instanceId, but for our flow we'd rather just synthesise a partial
  // instance via getInstance after create. So we keep this minimal.
  metadata: z
    .object({
      instanceId: z.string().optional(),
    })
    .optional(),
});

function mapInstance(raw: z.infer<typeof yandexInstanceSchema>): YandexInstance {
  const externalIpv4: string[] = [];
  for (const nic of raw.networkInterfaces ?? []) {
    const ext = nic.primaryV4Address?.oneToOneNat?.address;
    if (ext) externalIpv4.push(ext);
  }
  return {
    id: raw.id,
    folderId: raw.folderId,
    status: raw.status,
    externalIpv4,
    createdAt: raw.createdAt,
  };
}

function mapOperation(raw: z.infer<typeof yandexOperationSchema>): YandexOperation {
  return {
    id: raw.id,
    description: raw.description,
    done: raw.done,
    ...(raw.error != null ? { error: raw.error } : {}),
  };
}

export const createYandexClient = (deps: YandexComputeClientDeps): YandexComputeClient => {
  const { iamToken, baseUrl = DEFAULT_BASE_URL } = deps;
  const fetchFn = deps.fetch ?? globalThis.fetch;

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${iamToken}`,
        'Content-Type': 'application/json',
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Yandex 404: ${path}`,
        cause: { status: 404, body: text },
      });
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Yandex ${res.status}: ${path}`,
        cause: { status: res.status, body: text },
      });
    }

    if (res.status === 400 || res.status === 422) {
      const text = await res.text().catch(() => '');
      throw new ScanError({
        code: 'invalid_request',
        message: `Yandex ${res.status} unprocessable: ${path}`,
        cause: { status: res.status, body: text },
      });
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      throw new Error(`Yandex rate limit: ${path}`, { cause: { status: 429, retryAfter } });
    }

    if (res.status >= 500) {
      const text = await res.text().catch(() => '');
      throw new Error(`Yandex ${res.status}: ${path}`, {
        cause: { status: res.status, body: text },
      });
    }

    if (res.status === 204) return {};

    return res.json();
  };

  return {
    async createInstance(opts: YandexCreateInstanceOpts) {
      const body = {
        folderId: opts.folderId,
        name: opts.name,
        zoneId: opts.zoneId,
        platformId: opts.platformId,
        resourcesSpec: {
          memory: String(opts.resourcesSpec.memoryBytes),
          cores: String(opts.resourcesSpec.cores),
          coreFraction: String(opts.resourcesSpec.coreFraction),
        },
        bootDiskSpec: {
          autoDelete: true,
          diskSpec: {
            size: String(opts.bootDiskBytes),
            imageId: opts.imageId,
          },
        },
        networkInterfaceSpecs: [
          {
            subnetId: opts.subnetId,
            primaryV4AddressSpec: {
              oneToOneNatSpec: { ipVersion: 'IPV4' },
            },
          },
        ],
        metadata: {
          'user-data': opts.userData,
        },
        labels: opts.labels,
      };
      const raw = await request('POST', '/instances', body);
      const op = createInstanceResponseSchema.parse(raw);
      // Synthesise an Instance shape from operation metadata + provisioning
      // status. Caller must call getInstance() to learn external IP once
      // status becomes RUNNING.
      const instanceId = op.metadata?.instanceId;
      if (!instanceId) {
        throw new ScanError({
          code: 'create_failed',
          message: 'Yandex create returned operation without instanceId',
          cause: { operation: op.id },
        });
      }
      const instance: YandexInstance = {
        id: instanceId,
        folderId: opts.folderId,
        status: 'PROVISIONING',
        externalIpv4: [],
        createdAt: new Date().toISOString(),
      };
      return { instance, operation: mapOperation(op) };
    },

    async getInstance(instanceId: string) {
      const raw = await request('GET', `/instances/${instanceId}`);
      const parsed = yandexInstanceSchema.parse(raw);
      return mapInstance(parsed);
    },

    async deleteInstance(instanceId: string) {
      const raw = await request('DELETE', `/instances/${instanceId}`);
      const parsed = yandexOperationSchema.parse(raw);
      return mapOperation(parsed);
    },

    async getOperation(operationId: string) {
      const raw = await request('GET', `/operations/${operationId}`);
      const parsed = yandexOperationSchema.parse(raw);
      return mapOperation(parsed);
    },
  };
};
