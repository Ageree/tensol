// EE-3.A (2026-05-12) — Yandex Cloud Compute Cloud types for ephemeral scan VMs.
//
// Mirrors the Hetzner type surface (types.ts) but for the Yandex Compute Cloud
// REST API. Lives in its own file to avoid polluting Hetzner types until the
// scan-runner provider-agnostic refactor lands (separate workstream).
//
// References:
//   - Compute Cloud REST API: https://yandex.cloud/en/docs/compute/api-ref/Instance/
//   - Statuses enum: PROVISIONING|STARTING|RUNNING|STOPPING|STOPPED|RESTARTING|
//                    UPDATING|DELETING|ERROR|CRASHED
//   - Zones: ru-central1-a | ru-central1-b | ru-central1-d (c decommissioned).
//
// MVP scope: stateless single-zone instance create/get/delete with cloud-init
// user-data. No managed instance groups, no preemptible flag (preemptible
// would be cheaper but harder to reason about for forensic-grade scans).

import { z } from 'zod';

// Yandex Cloud platform IDs (CPU family).
// `standard-v3` is current default for new instances (Cascade Lake Xeon).
export const YANDEX_PLATFORM_IDS = ['standard-v2', 'standard-v3'] as const;
export type YandexPlatformId = (typeof YANDEX_PLATFORM_IDS)[number];

// Compute Cloud zones in ru-central1 region (ru-central1-c decommissioned 2024).
export const YANDEX_ZONES = ['ru-central1-a', 'ru-central1-b', 'ru-central1-d'] as const;
export type YandexZone = (typeof YANDEX_ZONES)[number];

// Yandex instance lifecycle statuses (REST API enum).
export const YANDEX_INSTANCE_STATUSES = [
  'PROVISIONING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'RESTARTING',
  'UPDATING',
  'DELETING',
  'ERROR',
  'CRASHED',
] as const;
export type YandexInstanceStatus = (typeof YANDEX_INSTANCE_STATUSES)[number];

export interface YandexInstance {
  readonly id: string;
  readonly folderId: string;
  readonly status: YandexInstanceStatus;
  /** Empty array until the instance reaches RUNNING and the NIC is assigned. */
  readonly externalIpv4: readonly string[];
  readonly createdAt: string;
}

export interface YandexOperation {
  readonly id: string;
  readonly description: string;
  readonly done: boolean;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface YandexResourcesSpec {
  /** Memory in bytes. 2 GB MVP default = 2 * 1024 * 1024 * 1024. */
  readonly memoryBytes: number;
  readonly cores: number;
  /** 100 = full vCPU, 20 = burstable (cheaper). MVP uses 100. */
  readonly coreFraction: number;
}

export interface YandexCreateInstanceOpts {
  readonly folderId: string;
  readonly name: string;
  readonly zoneId: YandexZone;
  readonly platformId: YandexPlatformId;
  readonly resourcesSpec: YandexResourcesSpec;
  /** Yandex image ID for the boot disk (e.g. ubuntu-22-04-lts image-id). */
  readonly imageId: string;
  /** Boot disk size in bytes. MVP default 20 GB. */
  readonly bootDiskBytes: number;
  /** Subnet to attach NIC to. MUST be in the same zone. */
  readonly subnetId: string;
  /** cloud-init #cloud-config payload (verbatim, no double-base64). */
  readonly userData: string;
  readonly labels: Record<string, string>;
}

export interface YandexComputeClient {
  createInstance(opts: YandexCreateInstanceOpts): Promise<{
    instance: YandexInstance;
    operation: YandexOperation;
  }>;
  getInstance(instanceId: string): Promise<YandexInstance>;
  deleteInstance(instanceId: string): Promise<YandexOperation>;
  /** Poll an operation until done or maxWaitMs elapses; returns final state. */
  getOperation(operationId: string): Promise<YandexOperation>;
}

export interface YandexComputeClientDeps {
  /**
   * Short-lived IAM token (12h). Caller refreshes via /iam/v1/tokens — that
   * exchange is OUT of scope for this client (caller wires its own
   * service-account-key → IAM-token rotation).
   */
  readonly iamToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

// Zod schemas for response parsing — exported for testing.
export const yandexInstanceSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  status: z.enum(YANDEX_INSTANCE_STATUSES),
  networkInterfaces: z
    .array(
      z.object({
        primaryV4Address: z
          .object({
            address: z.string().optional(),
            oneToOneNat: z
              .object({
                address: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  createdAt: z.string(),
});

export const yandexOperationSchema = z.object({
  id: z.string(),
  description: z.string().optional().default(''),
  done: z.boolean().default(false),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});
