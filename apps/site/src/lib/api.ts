// T081 — Shared HTTP client for Tensol Backend v2.
// Mirrors specs/001-backend-v2/contracts/openapi.yaml 1:1.
// All requests are cookie-authenticated (credentials: 'include').
//
// Base URL defaults to "" (relative paths) so Vite's dev proxy routes /api/*
// to the local Bun backend (see vite.config.ts). In production builds the
// frontend is served from the same origin as the API, so relative paths Just
// Work. Override with VITE_API_BASE_URL only for cross-origin deployments.

const BASE_URL: string =
  (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env
    ?.VITE_API_BASE_URL ?? '';

// ─── v2 ValidationError envelope ────────────────────────────────────────────

export interface ApiErrorBody {
  error: string;
  details?: unknown[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown[];

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `http_${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error || `http_${status}`;
    this.details = body.details;
  }
}

// ─── Domain types (mirror openapi.yaml component schemas) ──────────────────

export interface User {
  id: string;
  email: string;
  created_at: number;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
}

export interface Target {
  id: string;
  project_id: string;
  url: string;
  status: 'unverified' | 'verified' | 'expired';
  verified_at: number | null;
  created_at: number;
}

export interface AuthProofChallenge {
  id: string;
  target_id: string;
  challenge: string;
  expires_at: number;
  methods: {
    dns_txt?: string;
    file?: string;
    meta_tag?: string;
  };
}

export interface AuthProofAttempt {
  method: string;
  succeeded: boolean;
  note?: string | null;
}

export interface AuthProofResult {
  verified: boolean;
  method: 'dns_txt' | 'file' | 'meta_tag' | null;
  attempted: AuthProofAttempt[];
}

export type ScanProfile = 'recon' | 'standard' | 'max';
export type ScanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Scan {
  id: string;
  target_id: string;
  profile: ScanProfile;
  status: ScanStatus;
  failure_reason: string | null;
  started_at: number;
  completed_at: number | null;
  usage_tokens: number | null;
  usage_usd_cents: number | null;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  body_md: string;
  evidence?: Record<string, unknown> | null;
  created_at: number;
}

export interface ScanDetail extends Scan {
  findings?: Finding[];
}

export interface AuditEntry {
  id: number;
  ts: number;
  event: string;
  outcome: 'success' | 'failure' | 'rejected';
  severity?: string | null;
  metadata?: Record<string, unknown>;
}

// ─── Core fetch wrapper ─────────────────────────────────────────────────────

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** When true, do not parse a body (e.g. 204 responses). */
  noBody?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: opts.body
      ? { 'content-type': 'application/json' }
      : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  };

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch (cause) {
    throw new ApiError(0, { error: 'network_error' });
  }

  if (res.status === 204 || opts.noBody) {
    return undefined as T;
  }

  // Try to parse JSON regardless of status — both success and error envelopes
  // are JSON per the v2 contract.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (res.ok) return undefined as T;
    throw new ApiError(res.status, { error: 'parse_error' });
  }

  if (!res.ok) {
    const body = parsed as Partial<ApiErrorBody>;
    throw new ApiError(res.status, {
      error: body?.error || `http_${res.status}`,
      details: body?.details,
    });
  }

  return parsed as T;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export const auth = {
  requestLink: (email: string): Promise<void> =>
    request<void>('/api/auth/request-link', {
      method: 'POST',
      body: { email },
      noBody: true,
    }),

  /** Path users hit when redeeming a magic link. The browser follows the 302
   *  itself; this helper is only useful if you want to programmatically follow
   *  the redirect (e.g. from a server-rendered context). */
  verifyPath: (token: string): string =>
    `${BASE_URL}/api/auth/verify?token=${encodeURIComponent(token)}`,

  me: (): Promise<User> => request<User>('/api/auth/me'),

  logout: (): Promise<void> =>
    request<void>('/api/auth/logout', { method: 'POST', noBody: true }),
};

// ─── Projects ───────────────────────────────────────────────────────────────

export const projects = {
  list: (): Promise<Project[]> => request<Project[]>('/api/projects'),

  create: (name: string): Promise<Project> =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: { name },
    }),

  remove: (projectId: string): Promise<void> =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      noBody: true,
    }),
};

// ─── Targets ────────────────────────────────────────────────────────────────

export const targets = {
  list: (projectId: string): Promise<Target[]> =>
    request<Target[]>(
      `/api/projects/${encodeURIComponent(projectId)}/targets`,
    ),

  create: (projectId: string, url: string): Promise<Target> =>
    request<Target>(
      `/api/projects/${encodeURIComponent(projectId)}/targets`,
      { method: 'POST', body: { url } },
    ),

  remove: (targetId: string): Promise<void> =>
    request<void>(`/api/targets/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
      noBody: true,
    }),

  issueChallenge: (targetId: string): Promise<AuthProofChallenge> =>
    request<AuthProofChallenge>(
      `/api/targets/${encodeURIComponent(targetId)}/auth-proof/challenge`,
      { method: 'POST' },
    ),

  verifyChallenge: (targetId: string): Promise<AuthProofResult> =>
    request<AuthProofResult>(
      `/api/targets/${encodeURIComponent(targetId)}/auth-proof/verify`,
      { method: 'POST' },
    ),
};

// ─── Scans ──────────────────────────────────────────────────────────────────

export const scans = {
  list: (): Promise<Scan[]> => request<Scan[]>('/api/scans'),

  create: (input: { target_id: string; profile: ScanProfile }): Promise<Scan> =>
    request<Scan>('/api/scans', { method: 'POST', body: input }),

  get: (scanId: string): Promise<ScanDetail> =>
    request<ScanDetail>(`/api/scans/${encodeURIComponent(scanId)}`),

  cancel: (scanId: string): Promise<void> =>
    request<void>(`/api/scans/${encodeURIComponent(scanId)}/cancel`, {
      method: 'POST',
      noBody: true,
    }),

  audit: (scanId: string): Promise<AuditEntry[]> =>
    request<AuditEntry[]>(
      `/api/scans/${encodeURIComponent(scanId)}/audit`,
    ),
};

// ─── Top-level convenience export ──────────────────────────────────────────

export const api = { auth, projects, targets, scans };
