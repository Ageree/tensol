// Sprint 6 — ScopeActionInput zod DTO.
//
// The candidate-action shape passed to POST /api/v1/assessments/:id/scope/validate.
// Discriminated union on `kind`. Engine consumes the parsed type via
// @cyberstrike/scope-engine; this file lives in @cyberstrike/contracts so the
// engine remains zod-only (no I/O).

import { z } from 'zod';
import { CLOUD_PROVIDERS, HTTP_METHODS, TOOL_CATEGORIES, VCS_PROVIDERS } from './scope-rules.ts';

const httpMethodEnum = z.enum(HTTP_METHODS);
const toolCategoryEnum = z.enum(TOOL_CATEGORIES);
const cloudProviderEnum = z.enum(CLOUD_PROVIDERS);
const vcsProviderEnum = z.enum(VCS_PROVIDERS);

// codex iter-4 P2 — http_request only accepts http/https/ws/wss schemes.
// `z.string().url()` accepts `ftp://`, `gopher://`, `file://`, etc., which
// would slip past the protocol-rule dimension (normalizeAction only maps
// http/https/ws/wss → Protocol). Reject everything else at the contract
// boundary so the engine never sees an unsupported scheme.
const HTTP_REQUEST_ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const httpRequestUrlSchema = z
  .string()
  .url()
  .max(8192)
  .refine(
    (raw) => {
      try {
        return HTTP_REQUEST_ALLOWED_SCHEMES.has(new URL(raw).protocol);
      } catch {
        return false;
      }
    },
    { message: 'http_request url must use scheme http, https, ws, or wss' },
  );

// ---------------------------------------------------------------------------
// http_request — URL + optional method + optional redirect-target list (R11
// + A-SE-SSRF-4 cross-scope redirect simulation).
// ---------------------------------------------------------------------------
const httpRequestAction = z
  .object({
    kind: z.literal('http_request'),
    url: httpRequestUrlSchema,
    method: httpMethodEnum.optional(),
    /**
     * Optional list of redirect destinations the caller intends to follow. The
     * engine evaluates each independently; any deny → overall deny + audit.
     * codex iter-4 P2 — same scheme allowlist applies.
     */
    followRedirectsTo: z.array(httpRequestUrlSchema).max(16).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// dns_lookup — pre-resolution probe.
// ---------------------------------------------------------------------------
const dnsLookupAction = z
  .object({
    kind: z.literal('dns_lookup'),
    host: z.string().min(1).max(253),
  })
  .strict();

// ---------------------------------------------------------------------------
// tcp_connect — host + port.
// ---------------------------------------------------------------------------
const tcpConnectAction = z
  .object({
    kind: z.literal('tcp_connect'),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

// ---------------------------------------------------------------------------
// tool_invoke — tool category + name + target reference (URL/host/IP/etc).
// targetRef is left as a free string; the engine evaluates the corresponding
// dimension matchers (host, ip, url_prefix, etc.) against it after attempting
// to parse it as URL/IP/host.
// ---------------------------------------------------------------------------
const toolInvokeAction = z
  .object({
    kind: z.literal('tool_invoke'),
    toolName: z.string().min(1).max(128),
    toolCategory: toolCategoryEnum,
    targetRef: z.string().min(1).max(2048),
  })
  .strict();

// ---------------------------------------------------------------------------
// cloud_call — provider + account ID + opaque op.
// ---------------------------------------------------------------------------
const cloudCallAction = z
  .object({
    kind: z.literal('cloud_call'),
    provider: cloudProviderEnum,
    accountId: z.string().min(1).max(128),
    op: z.string().min(1).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// k8s_call — cluster + namespace + opaque op.
// ---------------------------------------------------------------------------
const k8sCallAction = z
  .object({
    kind: z.literal('k8s_call'),
    cluster: z.string().min(1).max(253),
    namespace: z.string().min(1).max(63),
    op: z.string().min(1).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// repo_op — vcs + owner + name + op.
// ---------------------------------------------------------------------------
const repoOpAction = z
  .object({
    kind: z.literal('repo_op'),
    vcs: vcsProviderEnum,
    owner: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    op: z.string().min(1).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union — single export.
// ---------------------------------------------------------------------------
export const scopeActionInputSchema = z.discriminatedUnion('kind', [
  httpRequestAction,
  dnsLookupAction,
  tcpConnectAction,
  toolInvokeAction,
  cloudCallAction,
  k8sCallAction,
  repoOpAction,
]);

export type ScopeActionInput = z.infer<typeof scopeActionInputSchema>;

export const SCOPE_ACTION_KINDS = [
  'http_request',
  'dns_lookup',
  'tcp_connect',
  'tool_invoke',
  'cloud_call',
  'k8s_call',
  'repo_op',
] as const;
export type ScopeActionKind = (typeof SCOPE_ACTION_KINDS)[number];
