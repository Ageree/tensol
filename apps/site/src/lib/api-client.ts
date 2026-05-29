// T077 — Typed HTTP client for `/v1/scan-orders/*` + `/v1/scans/*`.
//
// Mirrors specs/002-blackbox-mvp/contracts/openapi.yaml 1:1. All requests
// are cookie-authenticated (Constitution VIII — session cookie). Snake_case
// field names match the wire contract exactly; we do NOT translate to
// camelCase at this layer (page components read snake_case directly, which
// keeps grep-ability against the openapi).
//
// This is a sibling to `api.ts` (the legacy v1 backend client). The two
// coexist while pages migrate from `/api/*` → `/v1/*`.

const BASE_URL: string =
  (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env
    ?.VITE_API_BASE_URL ?? "";

// ─── Error envelope ────────────────────────────────────────────────────────
// openapi.yaml component schema `Error`:
//   { error: string (code), message: string, retry_after_seconds?: number|null }
// Validation routes (Zod 422) additionally include `details: unknown[]`.

export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
  retry_after_seconds?: number | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error || `http_${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error || `http_${status}`;
    this.details = body.details;
    this.retryAfterSeconds = body.retry_after_seconds ?? null;
  }
}

// ─── Domain types (hand-mirrored from openapi.yaml component schemas) ──────
// Cross-importing server-side Zod schemas would couple apps/site to server's
// build graph + drizzle deps. Hand-mirroring keeps the frontend
// self-contained. Snake_case matches the wire contract.

export type ScanOrderStatus =
  | "draft"
  | "dns_pending"
  | "dns_verified"
  | "vm_provisioning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ScanOrderTier = "quick" | "deep";

export type PaymentKind = "free_quick" | "yookassa";

export interface AttackSurfaceHeader {
  k: string;
  v: string;
}

export interface AttackSurfaceEntry {
  domain: string;
  primary: boolean;
  headers: AttackSurfaceHeader[];
}

export interface ScanOrder {
  id: string;
  user_id: string;
  status: ScanOrderStatus;
  tier: ScanOrderTier;
  primary_domain: string;
  attack_surface: AttackSurfaceEntry[];
  safety_rps: number;
  payment_kind: PaymentKind;
  created_at: number;
  updated_at: number;
  // Nullable / optional per openapi
  dns_verify_token?: string | null;
  dns_verified_at?: number | null;
  scan_id?: string | null;
  failure_reason?: string | null;
  amount_kopecks?: number | null;
}

export type ScanProfile = "recon" | "standard" | "max";

export type ScanStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ScanSummary {
  id: string;
  user_id: string;
  scan_order_id: string;
  profile: ScanProfile;
  status: ScanStatus;
  failure_reason?: string | null;
  started_at: number;
  completed_at?: number | null;
  usage_tokens?: number | null;
  usage_usd_cents?: number | null;
}

export type ScanEventType =
  | "vm_provisioning"
  | "vm_ready"
  | "vm_teardown"
  | "agent_started"
  | "agent_phase_changed"
  | "finding_detected"
  | "scan_completed"
  | "scan_failed";

export interface ScanEvent {
  id: string;
  scan_id: string;
  event_type: ScanEventType;
  payload?: Record<string, unknown> | null;
  created_at: number;
}

export type Severity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export type FindingConfidence = "verified" | "high" | "medium" | "low";

export interface Finding {
  id: string;
  scan_id: string;
  external_id: string;
  severity: Severity;
  title: string;
  target: string;
  cvss_score?: number | null;
  cvss_vector?: string | null;
  cvss_version?: string | null;
  cwe: string[];
  mitre: string[];
  confidence?: FindingConfidence | null;
  phase?: string | null;
  agent?: string | null;
  body_md: string;
  evidence_keys: string[];
  discovered_at?: number | null;
  created_at: number;
}

// FindingDetail is the same shape as Finding in the current contract (the
// list and detail endpoints both return the full `Finding` schema). We
// re-export under an alias for forward-compat (e.g. if `evidence_inline`
// gets added to detail later).
export type FindingDetail = Finding;

// DNS verify token request response (POST /scan-orders/:id/dns-verify/request)
export interface DnsVerifyInstructions {
  record_type: "TXT";
  record_name: string;
  record_value: string;
  ttl_hint?: number;
}

export interface DnsVerifyRequestResult {
  token: string;
  instructions: DnsVerifyInstructions;
}

// DNS verify poll response (GET /scan-orders/:id/dns-verify/check)
export interface DnsVerifyCheckResult {
  verified: boolean;
  attempts: number;
  remaining_window_seconds: number;
  last_error?: string | null;
}

// Launch response (POST /scan-orders/:id/launch, 202)
export interface LaunchScanResult {
  scan_id: string;
}

// Report status + signed download (GET /scans/:id/report)
export type ReportStatus = "pending" | "rendering" | "ready" | "failed";

export interface ReportResponse {
  status: ReportStatus;
  download_url?: string | null;
  download_expires_at?: number | null;
  byte_size?: number | null;
}

// Regenerate response (POST /scans/:id/report/regenerate, 202)
export interface ReportRegenerateResult {
  report_id: string;
  job_id: string;
}

// Feature flags (GET /v1/config/feature-flags) — see openapi.yaml + T073.
export interface FeatureFlags {
  yookassa_live: boolean;
}

// Auth (GET /v1/auth/me) — used by US2 deep-inquiry prefill (T106).
// Anonymous callers receive a 401 which we map back to `null`.
export interface AuthMe {
  id: string;
  email: string;
  free_quick_available?: boolean;
  free_quick_resets_at?: number | null;
}

// Deep inquiry (POST /v1/deep-inquiries) — US2 lead-gen funnel.
// Mirrors `server/src/schemas/deep-inquiries.ts` CreateInquiryBodySchema and
// `specs/002-blackbox-mvp/contracts/openapi.yaml` 1:1.
export type DeepInquiryBudgetBand =
  | "under_500k"
  | "500k_1m"
  | "1m_3m"
  | "3m_plus"
  | "open";

export interface CreateDeepInquiryBody {
  company: string;
  contact_name: string;
  position?: string | null;
  email?: string | null;
  phone: string;
  domains_text: string;
  desired_date?: number | null;
  budget_band?: DeepInquiryBudgetBand | null;
  scope_text: string;
  consent_accepted: true;
}

export interface DeepInquiryCreateResult {
  id: string;
}

// ─── Request body types ────────────────────────────────────────────────────

export interface CreateScanOrderBody {
  tier: "quick"; // Deep doesn't create scan-orders in MVP
  primary_domain: string;
}

export interface UpdateAttackSurfaceBody {
  attack_surface: AttackSurfaceEntry[];
}

export interface UpdateSafetyBody {
  safety_rps: number;
}

// ─── Core fetch wrapper ────────────────────────────────────────────────────

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return `${BASE_URL}${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `${BASE_URL}${path}${qs ? `?${qs}` : ""}`;
}

async function request<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const hasBody = opts.body !== undefined;
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  };

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), init);
  } catch {
    throw new ApiError(0, {
      error: "network_error",
      message: "Failed to reach Tensol API",
    });
  }

  // Parse JSON body when present. Empty 200/204 → return undefined as T.
  const contentType = res.headers.get("content-type") ?? "";
  const expectsJson = contentType.includes("application/json");

  let parsed: unknown = undefined;
  if (expectsJson) {
    try {
      parsed = await res.json();
    } catch {
      if (res.ok) return undefined as T;
      throw new ApiError(res.status, {
        error: "parse_error",
        message: "Response was not valid JSON",
      });
    }
  } else if (res.ok) {
    const text = await res.text().catch(() => "");
    if (text.trim().length > 0) {
      throw new ApiError(res.status, {
        error: "parse_error",
        message: "Expected a JSON response from Tensol API",
      });
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, {
      error: body.error || `http_${res.status}`,
      message: body.message,
      details: body.details,
      retry_after_seconds: body.retry_after_seconds ?? null,
    });
  }

  return parsed as T;
}

// ─── Scan Orders (9 endpoints) ─────────────────────────────────────────────

function orderPath(id: string, suffix: string = ""): string {
  return `/v1/scan-orders/${encodeURIComponent(id)}${suffix}`;
}

export const scanOrders = {
  /** GET /v1/scan-orders — list caller's orders. */
  list: (): Promise<ScanOrder[]> => request<ScanOrder[]>("/v1/scan-orders"),

  /** POST /v1/scan-orders — create a draft (201). */
  create: (body: CreateScanOrderBody): Promise<ScanOrder> =>
    request<ScanOrder>("/v1/scan-orders", { method: "POST", body }),

  /** GET /v1/scan-orders/:id — fetch one. */
  get: (id: string): Promise<ScanOrder> => request<ScanOrder>(orderPath(id)),

  /** PUT /v1/scan-orders/:id/attack-surface — Step 1 commit. */
  updateAttackSurface: (
    id: string,
    body: UpdateAttackSurfaceBody,
  ): Promise<ScanOrder> =>
    request<ScanOrder>(orderPath(id, "/attack-surface"), {
      method: "PUT",
      body,
    }),

  /** PUT /v1/scan-orders/:id/safety — Step 2 commit. */
  updateSafety: (id: string, body: UpdateSafetyBody): Promise<ScanOrder> =>
    request<ScanOrder>(orderPath(id, "/safety"), { method: "PUT", body }),

  /** POST /v1/scan-orders/:id/dns-verify/request — Step 3 begin. */
  requestDnsVerify: (id: string): Promise<DnsVerifyRequestResult> =>
    request<DnsVerifyRequestResult>(orderPath(id, "/dns-verify/request"), {
      method: "POST",
    }),

  /** GET /v1/scan-orders/:id/dns-verify/check — Step 3 poll. */
  checkDnsVerify: (id: string): Promise<DnsVerifyCheckResult> =>
    request<DnsVerifyCheckResult>(orderPath(id, "/dns-verify/check")),

  /** POST /v1/scan-orders/:id/launch — Step 4 commit (202). */
  launch: (id: string): Promise<LaunchScanResult> =>
    request<LaunchScanResult>(orderPath(id, "/launch"), { method: "POST" }),

  /** DELETE /v1/scan-orders/:id — cancel an order or scan in flight. */
  cancel: (id: string): Promise<ScanOrder> =>
    request<ScanOrder>(orderPath(id), { method: "DELETE" }),
};

// ─── Scans (6 endpoints) ───────────────────────────────────────────────────

function scanPath(id: string, suffix: string = ""): string {
  return `/v1/scans/${encodeURIComponent(id)}${suffix}`;
}

export const scans = {
  /** GET /v1/scans/:id — scan summary. */
  get: (id: string): Promise<ScanSummary> =>
    request<ScanSummary>(scanPath(id)),

  /**
   * GET /v1/scans/:id/events?since=<unix-ms> — polled event stream.
   * Returns events strictly after `since` (ms). Omit `since` to get all.
   */
  getEvents: (id: string, since?: number): Promise<ScanEvent[]> =>
    request<ScanEvent[]>(scanPath(id, "/events"), {
      query: since !== undefined ? { since } : undefined,
    }),

  /** GET /v1/scans/:id/findings — list (severity-ranked). */
  getFindings: (id: string): Promise<Finding[]> =>
    request<Finding[]>(scanPath(id, "/findings")),

  /** GET /v1/scans/:id/findings/:findingId — single finding detail. */
  getFindingDetail: (
    id: string,
    findingId: string,
  ): Promise<FindingDetail> =>
    request<FindingDetail>(
      `${scanPath(id, "/findings")}/${encodeURIComponent(findingId)}`,
    ),

  /** GET /v1/scans/:id/report — report status + signed download URL. */
  getReport: (id: string): Promise<ReportResponse> =>
    request<ReportResponse>(scanPath(id, "/report")),

  /** POST /v1/scans/:id/report/regenerate — re-render PDF (202). */
  regenerateReport: (id: string): Promise<ReportRegenerateResult> =>
    request<ReportRegenerateResult>(scanPath(id, "/report/regenerate"), {
      method: "POST",
    }),
};

// ─── Config (1 endpoint) ───────────────────────────────────────────────────

export const config = {
  /** GET /v1/config/feature-flags — public, no auth required. */
  getFeatureFlags: (): Promise<FeatureFlags> =>
    request<FeatureFlags>("/v1/config/feature-flags"),
};

// ─── Auth (T106 — US2 prefill) ─────────────────────────────────────────────

export const auth = {
  /**
   * GET /v1/auth/me — current user session.
   *
   * Anonymous callers get a 401 — we map that to `null` so the deep-inquiry
   * form can transparently fall back to the anonymous flow. Other errors
   * (network, 5xx) continue to throw `ApiError` so callers can decide.
   */
  me: async (): Promise<AuthMe | null> => {
    try {
      return await request<AuthMe>("/v1/auth/me");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
};

// ─── Deep inquiries (T106 — US2 lead-gen funnel) ───────────────────────────

export const deepInquiries = {
  /** POST /v1/deep-inquiries — anonymous OR authenticated (201). */
  create: (body: CreateDeepInquiryBody): Promise<DeepInquiryCreateResult> =>
    request<DeepInquiryCreateResult>("/v1/deep-inquiries", {
      method: "POST",
      body,
    }),
};

// ─── GitHub / Installations (004-sthrip-pr-review) ────────────────────────
// Mirrors specs/004-sthrip-pr-review/contracts/openapi.yaml.
// All field names are snake_case to match the wire contract exactly (same
// convention as the rest of this file).

/**
 * GET /v1/github/connect response.
 * `install_url` is the GitHub App installation URL the frontend redirects to.
 * `state` is the CSRF nonce echoed back on the callback.
 */
export interface ConnectUrl {
  install_url: string;
  state?: string;
}

/** Shape of a single installation row returned by GET /v1/github/installations. */
export interface Installation {
  id: string;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  status: "active" | "suspended" | "deleted";
}

/** GET /v1/github/installations response envelope. */
export interface InstallationsResponse {
  connected: boolean;
  installations: Installation[];
}

/**
 * A repository accessible through a GitHub App installation,
 * with Sthrip coverage + settings state overlaid.
 * Mirrors openapi.yaml `InstallationRepo`.
 */
export interface InstallationRepo {
  /** Sthrip `review_repos.id` if this repo is already tracked; null otherwise. */
  repo_id?: string | null;
  owner: string;
  name: string;
  default_branch?: string;
  enabled: boolean;
  covered_branches?: string[];
  status_check_enabled?: boolean;
  merge_block_on_critical?: boolean;
  last_review?: {
    review_id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    score_0_5?: number | null;
    updated_at: number;
  } | null;
}

/**
 * Request body for PATCH /v1/review/repos/{id}/settings.
 * Mirrors openapi.yaml `RepoSettingsUpdate`.
 */
export interface RepoSettingsUpdate {
  enabled?: boolean;
  covered_branches?: string[];
  status_check_enabled?: boolean;
  merge_block_on_critical?: boolean;
}

export const github = {
  /**
   * GET /v1/github/connect — begin GitHub App connection.
   * Returns the install URL (redirect the browser there) and a CSRF state.
   */
  connect: (): Promise<ConnectUrl> =>
    request<ConnectUrl>("/v1/github/connect"),

  /**
   * GET /v1/github/installations — connection status + list of installations.
   * Returns `{ connected: false, installations: [] }` when the user has not
   * connected yet.
   */
  installations: (): Promise<InstallationsResponse> =>
    request<InstallationsResponse>("/v1/github/installations"),

  /**
   * GET /v1/github/installations/{installation_id}/repos
   * Lists repositories the installation can access with Sthrip coverage state.
   * 404 if the installation is not owned by the current user.
   */
  installationRepos: (installationId: string): Promise<InstallationRepo[]> =>
    request<InstallationRepo[]>(
      `/v1/github/installations/${encodeURIComponent(installationId)}/repos`,
    ),

  /**
   * PATCH /v1/review/repos/{repo_id}/settings
   * Update per-repo review coverage settings (enable/disable, branches, gates).
   * 403 if the repo is not owned by the current user.
   */
  updateRepoSettings: (
    repoId: string,
    body: RepoSettingsUpdate,
  ): Promise<InstallationRepo> =>
    request<InstallationRepo>(
      `/v1/review/repos/${encodeURIComponent(repoId)}/settings`,
      { method: "PATCH", body },
    ),

  /**
   * POST /v1/github/disconnect
   * Marks the installation as deleted locally; the user must also uninstall
   * the app on GitHub. 403 if the installation is not owned by the current user.
   */
  disconnect: (installationId: string): Promise<void> =>
    request<void>("/v1/github/disconnect", {
      method: "POST",
      body: { installation_id: installationId },
    }),
};

// ─── Review (003-whitebox: PR Review + Whitebox Pentest) ───────────────────
// Mirrors `server/src/review/*` + `.claude/skills/tensol-loop/references/api.md`.

export type ReviewKind = "pr" | "whitebox";
export type ReviewRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReviewFindingWire {
  fingerprint: string;
  file_path: string;
  start_line?: number | null;
  end_line?: number | null;
  side: "LEFT" | "RIGHT";
  severity: Severity;
  cwe: string[];
  cvss_vector?: string | null;
  cvss_score?: number | null;
  confidence?: FindingConfidence | null;
  reachable?: boolean | null;
  category?: string | null;
  title: string;
  rationale_md: string;
  poc_md?: string | null;
  fix_prompt_md?: string | null;
  source: "llm" | "sast" | "secrets" | "sca";
}

export interface ReviewResultWire {
  review_id: string;
  kind?: ReviewKind;
  status: ReviewRunStatus;
  score_0_5?: number | null;
  summary_md?: string | null;
  pr_number?: number | null;
  repo?: string | null;
  created_at?: number;
  completed_at?: number | null;
  findings: ReviewFindingWire[];
}

/**
 * GET /v1/review list-item shape. Distinct from `ReviewResultWire`: it carries
 * a counted `findings_count` instead of a full `findings` array (the list never
 * loads findings). Mirrors `server/src/routes/review.ts` GET / serializer.
 */
export interface ReviewListItemWire {
  review_id: string;
  kind?: ReviewKind;
  status: ReviewRunStatus;
  score_0_5?: number | null;
  pr_number?: number | null;
  repo?: string | null;
  created_at?: number;
  completed_at?: number | null;
  findings_count: number;
}

export interface ReviewRepoWire {
  id: string;
  scm: "github" | "gitlab" | "bitbucket";
  owner: string;
  name: string;
  default_branch: string;
  status: "active" | "paused" | "revoked";
  installation_id?: string | null;
  created_at?: number;
}

export interface CreateReviewBody {
  repo: string;
  pr?: number;
  head_sha?: string;
  base_sha?: string;
  diff?: string;
  files?: Array<{
    path: string;
    status?: "added" | "modified" | "removed" | "renamed";
    patch?: string;
    contents?: string;
    previous_path?: string;
  }>;
  sync?: boolean;
}

export interface LaunchWhiteboxBody {
  repo_id?: string;
  repo?: string;
  ref?: string;
}

export const review = {
  /** POST /v1/review — trigger a review (sync or async). */
  create: (body: CreateReviewBody): Promise<ReviewResultWire> =>
    request<ReviewResultWire>("/v1/review", { method: "POST", body }),

  /** GET /v1/review/:id — poll a review's status + findings. */
  get: (id: string): Promise<ReviewResultWire> =>
    request<ReviewResultWire>(`/v1/review/${encodeURIComponent(id)}`),

  /** GET /v1/review — list the caller's recent reviews (list-item shape). */
  list: (): Promise<ReviewListItemWire[]> =>
    request<ReviewListItemWire[]>("/v1/review"),

  /** GET /v1/review/repos — list connected source repos. */
  listRepos: (): Promise<ReviewRepoWire[]> =>
    request<ReviewRepoWire[]>("/v1/review/repos"),

  /** POST /v1/review/whitebox — launch a whole-repo whitebox scan (202). */
  launchWhitebox: (body: LaunchWhiteboxBody): Promise<{ review_id: string }> =>
    request<{ review_id: string }>("/v1/review/whitebox", {
      method: "POST",
      body,
    }),
};

// ─── Top-level convenience export ─────────────────────────────────────────

export const apiClient = {
  scanOrders,
  scans,
  config,
  auth,
  deepInquiries,
  review,
  github,
};
