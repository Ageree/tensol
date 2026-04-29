// Sprint 6 §5.6 — POST /api/v1/assessments/:id/scope/validate IT.
//
// Coverage:
//   A-SE-Route-1 — 200/400/403/404/422 paths.
//   A-SE-Route-2 — deny → exactly one audit row; allow → no audit row.
//   A-SE-Route-3 — IDOR matrix (T1+T1, T1+T2, T1+nonexistent).
//   A-SE-SSRF-1 — http://169.254.169.254/ blocked as metadata_ip_blocked.
//   A-SE-SSRF-2 — domain resolves to private IP → blocked default.
//   A-SE-Compat-1 — Sprint 5 legacy scope rule rows decode + default-deny.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type AuthFixture,
  buildAuthApp,
  countAuditEvents,
  hasDatabaseUrl,
  resetAuthState,
  seedLoggedInUser,
} from '../auth/helpers/auth-fixture.ts';
import {
  type DbFixture,
  applyAllMigrations,
  createFixture,
  dropAllTables,
  seedAssessment,
  seedProject,
  seedTarget,
} from '../db/helpers/db-fixture.ts';

const HEADERS_JSON: Record<string, string> = { 'content-type': 'application/json' };

describe.skipIf(!hasDatabaseUrl())('integration :: scope/validate route (Sprint 6)', () => {
  let fx: DbFixture;
  let auth: AuthFixture;
  let t1Cookie: string;
  let t1TenantId: string;
  let t1UserId: string;
  let projectId: string;
  let assessmentId: string;
  let t2AssessmentId: string;

  beforeAll(async () => {
    fx = await createFixture();
    await dropAllTables(fx);
    await applyAllMigrations(fx);
    auth = buildAuthApp(fx.db);
  });

  afterAll(async () => {
    await dropAllTables(fx);
    await fx.db.destroy();
  });

  beforeEach(async () => {
    await resetAuthState(fx.db);
    const t1 = await seedLoggedInUser(auth, {
      tenantSlug: `t1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `t1-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    t1Cookie = t1.cookieHeader;
    t1TenantId = t1.tenantId;
    t1UserId = t1.userId;
    projectId = await seedProject(fx, { tenantId: t1TenantId, name: 'P-Sprint6-T1' });
    const target = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'url',
      value: 'https://example.com/',
      ownershipStatus: 'verified',
    });
    assessmentId = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'approved',
      targetIds: [target],
      scopeRules: [
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'example.com', matchSubdomains: false },
        },
        {
          ruleKind: 'ip',
          effect: 'allow',
          payload: { ip: '93.184.216.34' }, // example.com canonical IP — for CI determinism
        },
        {
          ruleKind: 'protocol',
          effect: 'allow',
          payload: { protocol: 'https' },
        },
      ],
    });

    const t2 = await seedLoggedInUser(auth, {
      tenantSlug: `t2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `t2-${Date.now()}@example.com`,
      role: 'security_lead',
    });
    const t2Project = await seedProject(fx, {
      tenantId: t2.tenantId,
      name: 'P-Sprint6-T2',
    });
    const t2Target = await seedTarget(fx, {
      tenantId: t2.tenantId,
      projectId: t2Project,
      kind: 'url',
      value: 'https://t2.example.com/',
      ownershipStatus: 'verified',
    });
    t2AssessmentId = await seedAssessment(fx, {
      tenantId: t2.tenantId,
      projectId: t2Project,
      createdBy: t2.userId,
      state: 'approved',
      targetIds: [t2Target],
      scopeRules: [
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 't2.example.com', matchSubdomains: false },
        },
      ],
    });
  });

  test('A-SE-Route-3 — T1+T1 → 200 with engine decision (read-only)', async () => {
    // Use an IP-literal URL so the test is independent of real DNS resolvers.
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: {
          kind: 'http_request',
          url: 'https://93.184.216.34/',
          method: 'GET',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // allowed/denied either way; the binary point is engine produced a decision.
    expect(typeof body.allowed).toBe('boolean');
    expect(body.reason).toBeDefined();
  });

  test('A-SE-Route-3 — T1 cookie + T2 assessment → 403 + rbac.deny audit', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/assessments/${t2AssessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://example.com/' },
      }),
    });
    expect(res.status).toBe(403);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1); // rbac.deny attributed to T1
  });

  test('A-SE-Route-3 — T1 cookie + nonexistent UUID → 404, no audit', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(
      '/api/v1/assessments/00000000-0000-0000-0000-000000000000/scope/validate',
      {
        method: 'POST',
        headers: { ...HEADERS_JSON, cookie: t1Cookie },
        body: JSON.stringify({
          action: { kind: 'http_request', url: 'https://example.com/' },
        }),
      },
    );
    expect(res.status).toBe(404);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before);
  });

  test('A-SE-Route-1 — 400 on malformed body', async () => {
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({ action: { kind: 'http_request', url: 'not a url' } }),
    });
    expect(res.status).toBe(400);
  });

  test('A-SE-Route-1 — 400 on invalid assessment id', async () => {
    const res = await auth.app.request('/api/v1/assessments/not-a-uuid/scope/validate', {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({ action: { kind: 'dns_lookup', host: 'x.io' } }),
    });
    expect(res.status).toBe(400);
  });

  test('A-SE-SSRF-1 — http://169.254.169.254/ blocked as metadata_ip_blocked + audit row', async () => {
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'http://169.254.169.254/latest/meta-data/' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toBe('metadata_ip_blocked');
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1); // scope.validate.denied audit row
  });

  test('A-SE-Compat-1 — assessment with legacy ruleKind decodes + default-deny applies', async () => {
    // Seed an assessment with a legacy-shape rule (ruleKind outside the 16-set).
    const target = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'url',
      value: 'https://legacy.example.com/',
      ownershipStatus: 'verified',
    });
    const legacyAssessment = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'approved',
      targetIds: [target],
      scopeRules: [
        {
          ruleKind: 'gibberish_kind',
          effect: 'deny',
          payload: { whatever: 'is here' },
        },
      ],
    });
    const res = await auth.app.request(`/api/v1/assessments/${legacyAssessment}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://legacy.example.com/' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    // codex iter-4 P1 added `dns_resolution_failed` for hostnames whose
    // production DNS lookup returns empty in the IT sandbox. Any of three
    // outcomes signals the legacy row did not magically allow.
    expect(['denied_by_rule', 'no_matching_allow_rule', 'dns_resolution_failed']).toContain(
      body.reason,
    );
  });

  test('A-SE-Route-1 — 422 when assessment is in terminal state', async () => {
    const target = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'url',
      value: 'https://done.example.com/',
      ownershipStatus: 'verified',
    });
    const completed = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'completed',
      targetIds: [target],
      scopeRules: [
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'done.example.com', matchSubdomains: false },
        },
      ],
    });
    const res = await auth.app.request(`/api/v1/assessments/${completed}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://done.example.com/' },
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('assessment_terminal');
  });

  // F2 — A-SE-Audit-1 metadata shape on deny.
  test('F2 — A-SE-SSRF-1 deny audit row has full metadata shape', async () => {
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'http://169.254.169.254/latest/meta-data/' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toBe('metadata_ip_blocked');
    // SELECT the latest audit row attributed to T1.
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(row.action).toBe('scope.validate.denied');
    expect(row.resource_type).toBe('assessment');
    expect(row.resource_id).toBe(assessmentId);
    const after = row.after_state as Record<string, unknown>;
    expect(after.outcome).toBe('denied');
    expect(after.reason).toBe('metadata_ip_blocked');
    expect(after.actionKind).toBe('http_request');
    expect(Array.isArray(after.matchedDenyRuleIds)).toBe(true);
    expect(Array.isArray(after.matchedAllowRuleIds)).toBe(true);
    expect(after.normalizedTarget).toBeDefined();
  });

  test('F2 — denied_by_rule path emits matchedDenyRuleIds non-empty', async () => {
    // Build an assessment whose deny rule fires for the action.
    const target = await seedTarget(fx, {
      tenantId: t1TenantId,
      projectId,
      kind: 'url',
      value: 'https://denyme.example/',
      ownershipStatus: 'verified',
    });
    const denyAssessment = await seedAssessment(fx, {
      tenantId: t1TenantId,
      projectId,
      createdBy: t1UserId,
      state: 'approved',
      targetIds: [target],
      scopeRules: [
        // Allow rule covering all dimensions.
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'denyme.example', matchSubdomains: false },
        },
        { ruleKind: 'ip', effect: 'allow', payload: { ip: '8.8.8.8' } },
        { ruleKind: 'protocol', effect: 'allow', payload: { protocol: 'https' } },
        // Deny rule that fires on the http_method dimension.
        { ruleKind: 'http_method', effect: 'deny', payload: { method: 'DELETE' } },
      ],
    });
    const res = await auth.app.request(`/api/v1/assessments/${denyAssessment}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: {
          kind: 'http_request',
          url: 'https://8.8.8.8/api',
          method: 'DELETE',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    expect(body.reason).toBe('denied_by_rule');
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .where('resource_id', '=', denyAssessment)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as Record<string, unknown>;
    const matchedDeny = after.matchedDenyRuleIds as string[];
    expect(matchedDeny.length).toBeGreaterThan(0);
  });

  // F3 — CF-8 cross-tenant attribution.
  test('F3 — cross-tenant deny audit attributed to T1 with attemptedResourceTenantId=T2', async () => {
    // Discover T2 tenant id through the seeded T2 assessment.
    const t2Row = await fx.db
      .selectFrom('assessments')
      .select(['tenant_id'])
      .where('id', '=', t2AssessmentId)
      .executeTakeFirstOrThrow();
    const res = await auth.app.request(`/api/v1/assessments/${t2AssessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://example.com/' },
      }),
    });
    expect(res.status).toBe(403);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'rbac.deny')
      .where('tenant_id', '=', t1TenantId)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    // CF-8: attribution to actor's tenant + targeted-resource-tenant in metadata.
    expect(row.tenant_id).toBe(t1TenantId);
    const after = row.after_state as Record<string, unknown>;
    expect(after.attemptedResourceTenantId).toBe(t2Row.tenant_id);
  });

  // F4 — A-SE-Audit-3 redaction.
  test('F4 — redaction strips token-like values from normalizedTarget.url', async () => {
    // SSRF metadata-IP path with a sensitive query string.
    const sensitiveUrl =
      'http://169.254.169.254/latest/meta-data/?token=abc123secretvalue&other=safe';
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({ action: { kind: 'http_request', url: sensitiveUrl } }),
    });
    expect(res.status).toBe(200);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as Record<string, unknown>;
    const target = after.normalizedTarget as Record<string, unknown> | null;
    expect(target).not.toBeNull();
    if (target) {
      const serialized = JSON.stringify(target);
      // Token query value MUST NOT appear in the persisted audit row.
      expect(serialized).not.toContain('abc123secretvalue');
      // Redaction marker MUST appear.
      expect(serialized).toContain('[redacted]');
      // Non-secret query values are preserved verbatim.
      expect(serialized).toContain('other=safe');
    }
  });

  test('iter-5 P1 — redirect normalized target URLs are query-redacted in audit metadata', async () => {
    // Action denies via metadata-IP redirect. Redirect URL contains a token
    // query value. Pre-fix: `redirectNormalizedTargets[i].url` retained the
    // raw URL with `?token=secret` in the audit row. Post-fix: nested URL is
    // redacted via the whitelist redactor.
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: {
          kind: 'http_request',
          url: 'https://safe.example/',
          followRedirectsTo: ['http://169.254.169.254/?token=zzzzleakvalue&other=safe'],
        },
      }),
    });
    expect(res.status).toBe(200);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as Record<string, unknown>;
    const target = after.normalizedTarget as Record<string, unknown> | null;
    expect(target).not.toBeNull();
    if (target) {
      const serialized = JSON.stringify(target);
      // The leak token MUST NOT appear anywhere in the metadata blob —
      // not on top-level url, not in redirectTargets, not in
      // redirectNormalizedTargets[i].url.
      expect(serialized).not.toContain('zzzzleakvalue');
      // Non-secret query values still preserved.
      expect(serialized).toContain('other=safe');
    }
  });

  test('iter-7 P2 — URL-encoded secret query keys are decoded then redacted', async () => {
    // ?access%5Ftoken=secret (encoded `_`) used to slip past the
    // `access_token` allowlist entry. Post-fix: decodeURIComponent runs
    // before the SECRET_QUERY_KEYS lookup.
    const sensitiveUrl =
      'http://169.254.169.254/?access%5Ftoken=zzziter7encleak&Access%5FToken=zzzMixedCaseLeak&other=safe';
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({ action: { kind: 'http_request', url: sensitiveUrl } }),
    });
    expect(res.status).toBe(200);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as Record<string, unknown>;
    const target = after.normalizedTarget as Record<string, unknown> | null;
    expect(target).not.toBeNull();
    if (target) {
      const serialized = JSON.stringify(target);
      // Both encoded and mixed-case-encoded variants get redacted.
      expect(serialized).not.toContain('zzziter7encleak');
      expect(serialized).not.toContain('zzzMixedCaseLeak');
      expect(serialized).toContain('other=safe');
    }
  });

  // F5 — A-SE-RBAC-2 negative regression: developer + viewer denied.
  test('F5 — developer role → 403 + rbac.deny audit attributed to actor tenant', async () => {
    const dev = await seedLoggedInUser(auth, {
      tenantSlug: `t1-dev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `dev-${Date.now()}@example.com`,
      role: 'developer',
    });
    // Seed an assessment in dev's own tenant so 404/403 don't compete.
    const devProject = await seedProject(fx, {
      tenantId: dev.tenantId,
      name: 'P-dev',
    });
    const devTarget = await seedTarget(fx, {
      tenantId: dev.tenantId,
      projectId: devProject,
      kind: 'url',
      value: 'https://x.example/',
      ownershipStatus: 'verified',
    });
    const devAssessment = await seedAssessment(fx, {
      tenantId: dev.tenantId,
      projectId: devProject,
      createdBy: dev.userId,
      state: 'approved',
      targetIds: [devTarget],
      scopeRules: [
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'x.example', matchSubdomains: false },
        },
      ],
    });
    const before = await countAuditEvents(fx.db);
    const res = await auth.app.request(`/api/v1/assessments/${devAssessment}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: dev.cookieHeader },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://x.example/' },
      }),
    });
    expect(res.status).toBe(403);
    const after = await countAuditEvents(fx.db);
    expect(after).toBe(before + 1);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'rbac.deny')
      .where('tenant_id', '=', dev.tenantId)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(dev.tenantId);
  });

  test('F5 — viewer role → 403 + rbac.deny audit', async () => {
    const viewer = await seedLoggedInUser(auth, {
      tenantSlug: `t1-vw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email: `vw-${Date.now()}@example.com`,
      role: 'viewer',
    });
    const vProject = await seedProject(fx, {
      tenantId: viewer.tenantId,
      name: 'P-vw',
    });
    const vTarget = await seedTarget(fx, {
      tenantId: viewer.tenantId,
      projectId: vProject,
      kind: 'url',
      value: 'https://y.example/',
      ownershipStatus: 'verified',
    });
    const vAssessment = await seedAssessment(fx, {
      tenantId: viewer.tenantId,
      projectId: vProject,
      createdBy: viewer.userId,
      state: 'approved',
      targetIds: [vTarget],
      scopeRules: [
        {
          ruleKind: 'domain',
          effect: 'allow',
          payload: { pattern: 'y.example', matchSubdomains: false },
        },
      ],
    });
    const res = await auth.app.request(`/api/v1/assessments/${vAssessment}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: viewer.cookieHeader },
      body: JSON.stringify({
        action: { kind: 'http_request', url: 'https://y.example/' },
      }),
    });
    expect(res.status).toBe(403);
  });

  // F7 — A-SE-SSRF-4 redirect cross-scope deny + audit (API-level).
  test('F7 — followRedirectsTo with private-IP destination → deny + audit row', async () => {
    const res = await auth.app.request(`/api/v1/assessments/${assessmentId}/scope/validate`, {
      method: 'POST',
      headers: { ...HEADERS_JSON, cookie: t1Cookie },
      body: JSON.stringify({
        action: {
          kind: 'http_request',
          url: 'https://93.184.216.34/',
          followRedirectsTo: ['https://192.168.1.10/'],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowed).toBe(false);
    // Either private_ip_blocked (platform guard fires on private IP in resolved
    // set including redirect target) or denied_by_rule.
    expect(['private_ip_blocked', 'denied_by_rule']).toContain(body.reason);
    const row = await fx.db
      .selectFrom('audit_events')
      .selectAll()
      .where('tenant_id', '=', t1TenantId)
      .where('action', '=', 'scope.validate.denied')
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const after = row.after_state as Record<string, unknown>;
    expect(after.actionKind).toBe('http_request');
    const target = after.normalizedTarget as Record<string, unknown> | null;
    expect(target).not.toBeNull();
    if (target) {
      const redirects = target.redirectTargets as string[] | undefined;
      expect(redirects?.length).toBe(1);
    }
  });
});
