// Sprint 6 §5.6 — POST /api/v1/assessments/:id/scope/validate.
//
// Read-only (no Idempotency-Key). RBAC: tenant_admin, security_lead, operator
// (per A-SE-RBAC-1; auditor preserved by C10 invariant).
//
// Audit emission rules (A-SE-Route-2):
//   - allowed=true → no audit row.
//   - allowed=false → exactly one denyAudit row with action='scope.validate.denied'.
//
// IDOR precedence (A-SE-Route-3): T1+T1 → 200, T1+T2 → 403 + rbac.deny,
// T1+nonexistent → 404 (no audit).

import { RbacDenyError, assertCan } from '@cyberstrike/authz';
import { scopeValidateRequestSchema } from '@cyberstrike/contracts';
import type { Decision as ContractDecision } from '@cyberstrike/contracts';
import { decide } from '@cyberstrike/scope-engine';
import type { Decision as EngineDecision } from '@cyberstrike/scope-engine';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../middleware/session.ts';
import { buildScopeForAssessment, loadAssessmentMeta } from '../../scope-engine/build-scope.ts';
import { nodeDnsResolver } from '../../scope-engine/dns-resolver.ts';
import { inProcessRateLimitCounter } from '../../scope-engine/rate-limit.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../shared.ts';

const idParam = z.string().uuid();

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const safeJson = async (c: Context<SessionEnv>): Promise<unknown | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

// A-SE-Audit-3 — strip token-like values from URL query strings before persist.
// `redact()` from @cyberstrike/audit walks objects by key but doesn't reach
// inside URL strings; this helper handles the URL-string case.
const SECRET_QUERY_KEYS = new Set([
  'token',
  'password',
  'passwd',
  'secret',
  'cookie',
  'authorization',
  'mfa_secret',
  'totp_secret',
  'private_key',
  'api_key',
  'bearer',
  'jwt',
  'session_token',
  'access_token',
  'refresh_token',
]);

// codex iter-7 P2 — decode percent-encoded query keys before set lookup.
// Without this, `?access%5Ftoken=secret` (URL-encoded `_`) bypasses the
// `access_token` allowlist entry. Wrap in try/catch — a malformed encoding
// falls through to the raw match (still safe; only loses the encoded variant).
const decodeQueryKey = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const redactUrlQuery = (raw: string): string => {
  if (!raw.includes('?')) return raw;
  const [base, qs] = raw.split('?', 2) as [string, string];
  const parts = qs.split('&').map((kv) => {
    const eqIdx = kv.indexOf('=');
    if (eqIdx < 0) return kv;
    const key = kv.slice(0, eqIdx);
    const decoded = decodeQueryKey(key).toLowerCase();
    return SECRET_QUERY_KEYS.has(decoded) || SECRET_QUERY_KEYS.has(key.toLowerCase())
      ? `${key}=[redacted]`
      : kv;
  });
  return `${base}?${parts.join('&')}`;
};

// codex iter-5 P1 — audit metadata redaction is whitelist-based. Only fields
// in AUDIT_TARGET_WHITELIST are forwarded to the audit row; URL-bearing fields
// are query-redacted. Nested credential-bearing fields like
// `redirectNormalizedTargets[i].url` are stripped via recursive whitelist
// application, not hand-written one-shot copies.
const AUDIT_TARGET_WHITELIST = new Set<string>([
  'host',
  'hostHasMixedScript',
  'hostIsIp',
  'url',
  'port',
  'effectivePort',
  'protocol',
  'path',
  'method',
  'redirectTargets',
  'redirectNormalizedTargets',
  'toolName',
  'toolCategory',
  'cloudProvider',
  'cloudAccountId',
  'k8sCluster',
  'k8sNamespace',
  'vcs',
  'repoOwner',
  'repoName',
  'dnsResolution',
  // Note: resolvedIps deliberately omitted from audit (carries DNS results
  // that may be sensitive in some deployments and aren't needed for forensics).
]);

interface RedactableTarget {
  url?: string;
  redirectTargets?: readonly string[];
  redirectNormalizedTargets?: readonly RedactableTarget[];
  [k: string]: unknown;
}

const redactNormalizedTarget = (
  target: import('@cyberstrike/scope-engine').ResolvedTarget | undefined,
): RedactableTarget | undefined => {
  if (!target) return undefined;
  return whitelistAndRedact(target as Record<string, unknown>);
};

const whitelistAndRedact = (source: Record<string, unknown>): RedactableTarget => {
  const out: RedactableTarget = {};
  for (const [k, v] of Object.entries(source)) {
    if (!AUDIT_TARGET_WHITELIST.has(k)) continue;
    if (k === 'url' && typeof v === 'string') {
      out.url = redactUrlQuery(v);
    } else if (k === 'redirectTargets' && Array.isArray(v)) {
      out.redirectTargets = (v as string[]).map((u) => redactUrlQuery(u));
    } else if (k === 'redirectNormalizedTargets' && Array.isArray(v)) {
      out.redirectNormalizedTargets = (v as Array<Record<string, unknown>>).map((nested) =>
        whitelistAndRedact(nested),
      );
    } else {
      out[k] = v;
    }
  }
  return out;
};

export interface ScopeValidateDeps {
  /** Test seam — overrides production DnsResolver. */
  readonly dnsResolverOverride?: import('@cyberstrike/scope-engine').DnsResolver;
  /** Test seam — overrides production Clock. */
  readonly clockOverride?: import('@cyberstrike/scope-engine').Clock;
  /** Test seam — overrides production RateLimitCounter. */
  readonly rateLimitOverride?: import('@cyberstrike/scope-engine').RateLimitCounter;
}

export const handleScopeValidate = async (
  deps: RouteDeps & ScopeValidateDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const idResult = idParam.safeParse(c.req.param('id'));
  if (!idResult.success) {
    return c.json({ error: 'invalid_assessment_id' }, 400);
  }
  const assessmentId = idResult.data;

  // Step 1: existence + cross-tenant precedence.
  const meta = await loadAssessmentMeta(deps.db, assessmentId);
  if (!meta) {
    return c.json({ error: 'not_found' }, 404);
  }
  // assertOwnership throws RbacDenyError → onError handler emits rbac.deny audit.
  assertOwnership(actor.tenantId, {
    resourceType: 'assessment',
    resourceId: meta.id,
    resourceTenantId: meta.tenantId,
  });

  // Step 2: RBAC for scope_validate action.
  const rbacDecision = assertCan(actor, 'scope_validate', 'assessment');
  if (!rbacDecision.allowed) {
    throw new RbacDenyError({
      actorTenantId: actor.tenantId,
      attemptedResourceType: 'assessment',
      attemptedResourceId: meta.id,
      reason: `rbac: ${rbacDecision.reason}`,
    });
  }

  // Step 3: terminal-state check.
  if (meta.state === 'completed' || meta.state === 'cancelled' || meta.state === 'failed') {
    return c.json({ error: 'assessment_terminal', state: meta.state }, 422);
  }

  // Step 4: zod-validate request body.
  const raw = await safeJson(c);
  const parsed = scopeValidateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request_body', details: parsed.error.flatten() }, 400);
  }

  // Step 5: build effective scope from DB.
  const scope = await buildScopeForAssessment(deps.db, assessmentId);
  if (!scope) {
    // Race: assessment deleted between meta load and scope build.
    return c.json({ error: 'not_found' }, 404);
  }

  // Step 6: invoke the engine.
  const decision: EngineDecision = await decide(scope, parsed.data.action, {
    dns: deps.dnsResolverOverride ?? nodeDnsResolver,
    clock: deps.clockOverride ?? { now: () => new Date() },
    rateLimit: deps.rateLimitOverride ?? inProcessRateLimitCounter,
  });

  // Step 7: deny → audit; allow → no audit (read-only success; volume control).
  if (!decision.allowed) {
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'scope.validate.denied',
      outcome: 'denied',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'assessment',
      resourceId: assessmentId,
      assessmentId,
      ip: sourceIp(c),
      userAgent: userAgent(c),
      traceId: newTraceId(),
      metadata: {
        reason: decision.reason,
        matchedDenyRuleIds: [...decision.matchedDenyRuleIds],
        matchedAllowRuleIds: [...decision.matchedAllowRuleIds],
        actionKind: parsed.data.action.kind,
        normalizedTarget: redactNormalizedTarget(decision.normalizedTarget) ?? null,
      },
    });
  }

  // Convert engine's readonly arrays to contract's mutable arrays for the wire.
  const wire: ContractDecision = {
    allowed: decision.allowed,
    reason: decision.reason,
    matchedAllowRuleIds: [...decision.matchedAllowRuleIds],
    matchedDenyRuleIds: [...decision.matchedDenyRuleIds],
    ...(decision.normalizedTarget !== undefined
      ? { normalizedTarget: decision.normalizedTarget as Record<string, unknown> }
      : {}),
    ...(decision.toolPolicyResult !== undefined
      ? { toolPolicyResult: decision.toolPolicyResult as unknown as Record<string, unknown> }
      : {}),
    ...(decision.timeWindowResult !== undefined
      ? { timeWindowResult: decision.timeWindowResult as unknown as Record<string, unknown> }
      : {}),
  };
  return c.json(wire, 200);
};
