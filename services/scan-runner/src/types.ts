import { z } from 'zod';

export const HETZNER_SERVER_TYPES = ['cpx11', 'cpx21', 'cpx31'] as const;
export type HetznerServerType = (typeof HETZNER_SERVER_TYPES)[number];

export const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'] as const;
export type HetznerLocation = (typeof HETZNER_LOCATIONS)[number];

export const scanRequestSchema = z.object({
  scanId: z.string().min(1),
  tenantId: z.string().min(1),
  targetUrl: z.string().url(),
  serverType: z.enum(HETZNER_SERVER_TYPES),
  location: z.enum(HETZNER_LOCATIONS),
  imageId: z.number().int().positive(),
  callbackUrl: z.string().url(),
  callbackToken: z.string().min(1),
  maxRuntimeMs: z.number().int().positive(),
});

export type ScanRequest = z.infer<typeof scanRequestSchema>;

export interface HetznerServer {
  readonly id: number;
  readonly status: 'initializing' | 'starting' | 'running' | 'stopping' | 'off' | 'deleting';
  readonly publicNet: { readonly ipv4: { readonly ip: string } };
  readonly created: string;
}

export interface HetznerAction {
  readonly id: number;
  readonly command: string;
  readonly status: 'running' | 'success' | 'error';
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ScanResult {
  readonly scanId: string;
  readonly hetznerServerId: number;
  readonly publicIpv4: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: 'completed' | 'timeout' | 'create_failed' | 'destroy_failed';
  readonly logs: string;
}

export class ScanError extends Error {
  override readonly name = 'ScanError';
  readonly code:
    | 'create_failed'
    | 'ready_timeout'
    | 'callback_timeout'
    | 'destroy_failed'
    | 'invalid_request';
  override readonly cause?: unknown;

  constructor(opts: {
    code: ScanError['code'];
    message?: string;
    cause?: unknown;
  }) {
    super(opts.message ?? opts.code, { cause: opts.cause });
    this.code = opts.code;
    this.cause = opts.cause;
  }
}

export interface CreateServerOpts {
  readonly name: string;
  readonly serverType: HetznerServerType;
  readonly location: HetznerLocation;
  readonly imageId: number;
  readonly userData: string;
  readonly labels: Record<string, string>;
  readonly sshKeyIds?: readonly number[];
}

export interface HetznerClient {
  createServer(
    opts: CreateServerOpts,
  ): Promise<{ server: HetznerServer; action: HetznerAction; rootPassword?: string }>;
  getServer(id: number): Promise<HetznerServer>;
  deleteServer(id: number): Promise<HetznerAction>;
  getActions(serverId: number, ids?: readonly number[]): Promise<readonly HetznerAction[]>;
}

export interface HetznerClientDeps {
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

export interface ScanRunnerDeps {
  readonly hetzner: HetznerClient;
  readonly buildCloudInit: (opts: import('./cloud-init.ts').CloudInitOpts) => string;
  readonly buildUserAgent: (opts: { scanId: string }) => string;
  readonly callbackTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly awaitCallback: (scanId: string, signal: AbortSignal) => Promise<{ logs: string }>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly logger?: {
    info(msg: string, ctx?: object): void;
    warn(msg: string, ctx?: object): void;
    error(msg: string, ctx?: object): void;
  };
}

export interface ScanRunner {
  runScan(req: ScanRequest): Promise<ScanResult>;
}
