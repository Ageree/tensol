/**
 * T037 — VPS provider abstract interface.
 *
 * Concrete implementations (e.g. `./hetzner.ts`) implement this surface so
 * scan runners can spawn / poll / destroy short-lived VPS instances without
 * coupling to a specific cloud vendor.
 */

export type SpawnVpsArgs = {
  /** Scan ULID — used as a stable name suffix on the provider side. */
  scanId: string;
  /** HMAC key the spawned vps-agent uses to sign webhook callbacks. */
  signKey: string;
};

export type SpawnedVps = {
  /** Opaque provider-side server identifier (Hetzner: numeric, but string here). */
  provider_server_id: string;
  /** Public IPv4 the agent will reach back from. */
  ipv4: string;
};

export type VpsStatus =
  | "initializing"
  | "running"
  | "stopped"
  | "destroyed"
  | "unknown";

export type VpsProvider = {
  spawnVps(args: SpawnVpsArgs): Promise<SpawnedVps>;
  getVpsStatus(provider_server_id: string): Promise<VpsStatus>;
  /**
   * Idempotent: must resolve (no throw) if the server is already gone (404).
   * Caller (scan runner) is responsible for retry-with-backoff on 5xx.
   */
  destroyVps(provider_server_id: string): Promise<void>;
};
