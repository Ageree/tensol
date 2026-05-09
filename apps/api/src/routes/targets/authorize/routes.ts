import { assertCan } from '@cyberstrike/authz';
import type { Context } from 'hono';
import { z } from 'zod';
import { assertOwnership } from '../../../middleware/assert-ownership.ts';
import type { SessionEnv } from '../../../middleware/session.ts';
import { type RouteDeps, audit, newTraceId, sourceIp, userAgent } from '../../shared.ts';
import * as dnsTxtVerifier from './dns-txt-verifier.ts';
import * as fileUploadVerifier from './file-upload-verifier.ts';
import type { AuthMethod } from './types.ts';
import { lookupRegistrantEmail } from './whois-verifier.ts';

const idSchema = z.string().uuid();
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const methodSchema = z.enum(['dns_txt', 'file_upload', 'whois_email']);

const requireActor = (c: Context<SessionEnv>) => {
  const actor = c.get('actor');
  if (!actor) throw new Error('tenantGuard contract violation: actor missing');
  return actor;
};

const sha256Hex = async (plaintext: string): Promise<string> => {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(plaintext));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
};

const resolveTarget = async (deps: RouteDeps, targetId: string) =>
  deps.db
    .selectFrom('targets')
    .select(['id', 'tenant_id', 'project_id', 'kind', 'value', 'ownership_status'])
    .where('id', '=', targetId)
    .executeTakeFirst();

// ============================================================
// POST /api/v1/targets/:targetId/authorize/start
// ============================================================

export const handleAuthorizeStart = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);
  const nowMs = deps.nowMs?.() ?? Date.now();

  const targetIdRaw = c.req.param('targetId');
  const targetIdParsed = idSchema.safeParse(targetIdRaw);
  if (!targetIdParsed.success) return c.json({ error: 'invalid_request' }, 400);
  const targetId = targetIdParsed.data;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const parsed = z.object({ method: methodSchema }).strict().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { method } = parsed.data;

  const target = await resolveTarget(deps, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: target.id,
    resourceTenantId: target.tenant_id,
  });
  assertCan(actor, 'update', 'target');

  // Pre-flight: method ↔ kind compatibility
  if (method === 'dns_txt' && target.kind !== 'domain')
    return c.json({ error: 'method_incompatible_kind' }, 422);
  if (method === 'file_upload' && target.kind !== 'domain' && target.kind !== 'url')
    return c.json({ error: 'method_incompatible_kind' }, 422);
  if (method === 'whois_email' && target.kind !== 'domain')
    return c.json({ error: 'method_incompatible_kind' }, 422);

  // Existing row check
  const existing = await deps.db
    .selectFrom('target_authorizations')
    .selectAll()
    .where('target_id', '=', targetId)
    .where('method', '=', method)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  if (existing) {
    if (existing.status === 'verified') {
      return c.json({ status: 'verified', alreadyVerified: true }, 200);
    }
    if (existing.status === 'pending' && new Date(existing.expires_at) > new Date(nowMs)) {
      return c.json(
        {
          id: existing.id,
          method: existing.method as AuthMethod,
          status: 'pending',
          expiresAt: new Date(existing.expires_at).toISOString(),
          instructions: buildInstructions(method, target.value, existing.token_plaintext ?? ''),
        },
        200,
      );
    }
    // Expire stale pending or carry over failed
    if (existing.status === 'pending') {
      await deps.db
        .updateTable('target_authorizations')
        .set({ status: 'expired', updated_at: new Date(nowMs) })
        .where('id', '=', existing.id)
        .execute();
    }
  }

  // Generate challenge
  const domain = target.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  if (method === 'dns_txt') {
    const challenge = dnsTxtVerifier.generateChallenge(targetId, domain);
    const tokenHash = await sha256Hex(challenge.token);
    const row = await deps.db
      .insertInto('target_authorizations')
      .values({
        tenant_id: actor.tenantId,
        target_id: targetId,
        method,
        status: 'pending' as const,
        token_hash: tokenHash,
        token_plaintext: challenge.token,
        expires_at: new Date(nowMs + 24 * 60 * 60 * 1000),
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();

    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'auth_proof.start',
      outcome: 'success',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { method },
    });

    return c.json(
      {
        id: row.id,
        method,
        status: 'pending',
        expiresAt: new Date(row.expires_at).toISOString(),
        instructions: {
          kind: method,
          txtRecord: challenge.txtRecord,
        },
      },
      201,
    );
  }

  if (method === 'file_upload') {
    const originUrl = target.kind === 'url' ? target.value : `https://${target.value}`;
    const challenge = fileUploadVerifier.generateChallenge(targetId, originUrl);
    const tokenHash = await sha256Hex(challenge.token);
    const fullUrl = `${originUrl.replace(/\/$/, '')}${challenge.urlPath}`;
    const row = await deps.db
      .insertInto('target_authorizations')
      .values({
        tenant_id: actor.tenantId,
        target_id: targetId,
        method,
        status: 'pending' as const,
        token_hash: tokenHash,
        token_plaintext: challenge.token,
        expires_at: new Date(nowMs + 24 * 60 * 60 * 1000),
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();

    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'auth_proof.start',
      outcome: 'success',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { method },
    });

    return c.json(
      {
        id: row.id,
        method,
        status: 'pending',
        expiresAt: new Date(row.expires_at).toISOString(),
        instructions: {
          kind: method,
          file: { url: fullUrl, body: challenge.expectedBody },
        },
      },
      201,
    );
  }

  // whois_email
  const whoisClient = deps.whoisClient;
  const mailer = deps.mailer;
  if (!whoisClient || !mailer) return c.json({ error: 'whois_email_not_configured' }, 503);

  const emailResult = await lookupRegistrantEmail(domain, { whoisClient });
  if (!emailResult.email) {
    return c.json({ error: emailResult.reason ?? 'no_registrant_email' }, 422);
  }

  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const tokenPlaintext = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(tokenPlaintext);

  const publicBaseUrl = deps.publicBaseUrl ?? 'http://localhost:3000';

  const mailResult = await mailer
    .send({
      to: emailResult.email,
      subject: 'Tensol — подтверждение прав на домен / Domain authorization',
      textBody: buildEmailBody(tokenPlaintext, targetId, target.project_id, publicBaseUrl),
      traceId,
    })
    .catch(() => null);

  if (!mailResult) return c.json({ error: 'email_send_failed' }, 502);

  const row = await deps.db
    .insertInto('target_authorizations')
    .values({
      tenant_id: actor.tenantId,
      target_id: targetId,
      method,
      status: 'pending' as const,
      token_hash: tokenHash,
      token_plaintext: null,
      email_recipient: emailResult.email,
      expires_at: new Date(nowMs + 24 * 60 * 60 * 1000),
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth_proof.email.sent',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: {
      method: 'whois_email',
      recipientHashed: (await sha256Hex(emailResult.email)).slice(0, 16),
    },
  });

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth_proof.start',
    outcome: 'success',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: { method },
  });

  return c.json(
    {
      id: row.id,
      method,
      status: 'pending',
      expiresAt: new Date(row.expires_at).toISOString(),
      instructions: {
        kind: method,
        email: { recipient: emailResult.email },
      },
    },
    201,
  );
};

// ============================================================
// POST /api/v1/targets/:targetId/authorize/verify
// ============================================================

export const handleAuthorizeVerify = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);
  const traceId = newTraceId();
  const ip = sourceIp(c);
  const ua = userAgent(c);
  const nowMs = deps.nowMs?.() ?? Date.now();

  const targetIdRaw = c.req.param('targetId');
  const targetIdParsed = idSchema.safeParse(targetIdRaw);
  if (!targetIdParsed.success) return c.json({ error: 'invalid_request' }, 400);
  const targetId = targetIdParsed.data;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const parsed = z.object({ method: methodSchema }).strict().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { method } = parsed.data;

  const target = await resolveTarget(deps, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: target.id,
    resourceTenantId: target.tenant_id,
  });
  assertCan(actor, 'update', 'target');

  // Rate-limit gate (per-target, per-hour, cap=10)
  const rlResult = deps.rateLimiter.recordFailureAndCheck(`auth-proof:${targetId}`);
  if (rlResult.rejected) {
    return c.json({ error: 'too_many_attempts', retryAfter: rlResult.retryAfter }, 429);
  }

  const row = await deps.db
    .selectFrom('target_authorizations')
    .selectAll()
    .where('target_id', '=', targetId)
    .where('method', '=', method)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  if (!row) return c.json({ error: 'no_pending_challenge' }, 404);

  if (new Date(row.expires_at) <= new Date(nowMs)) {
    await deps.db
      .updateTable('target_authorizations')
      .set({ status: 'expired', updated_at: new Date(nowMs) })
      .where('id', '=', row.id)
      .execute();
    return c.json({ error: 'token_expired' }, 410);
  }

  // whois_email verification only happens via email-confirm redirect
  if (method === 'whois_email') {
    return c.json({ status: 'pending', reason: 'awaiting_email_click' }, 202);
  }

  const plaintext = row.token_plaintext ?? '';
  let verifyResult: { ok: boolean; reason?: string };

  if (method === 'dns_txt') {
    const domain = target.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    verifyResult = await dnsTxtVerifier.verify(domain, plaintext, {
      dnsResolver: deps.dnsResolver,
    });
  } else {
    const originUrl = target.kind === 'url' ? target.value : `https://${target.value}`;
    const httpFetcher = deps.httpFetcher;
    if (!httpFetcher) return c.json({ error: 'http_fetcher_not_configured' }, 503);
    verifyResult = await fileUploadVerifier.verify(originUrl, plaintext, { httpFetcher });
  }

  if (verifyResult.ok) {
    const now = new Date(nowMs);
    await deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('target_authorizations')
        .set({ status: 'verified', verified_at: now, token_plaintext: null, updated_at: now })
        .where('id', '=', row.id)
        .execute();
      await trx
        .updateTable('targets')
        .set({ ownership_status: 'verified', updated_at: now })
        .where('id', '=', targetId)
        .where('ownership_status', '!=', 'verified')
        .execute();
    });
    deps.rateLimiter.reset(`auth-proof:${targetId}`);
    await audit(deps, {
      tenantId: actor.tenantId,
      action: 'auth_proof.verify.success',
      outcome: 'success',
      actorType: 'user',
      actorId: actor.id,
      actorName: actor.email,
      resourceType: 'target',
      resourceId: targetId,
      ip,
      userAgent: ua,
      traceId,
      metadata: { method },
    });
    return c.json({ status: 'verified' }, 200);
  }

  // Failure path
  const newCount = (row.attempt_count ?? 0) + 1;
  const newStatus = newCount >= 10 ? 'failed' : 'pending';
  await deps.db
    .updateTable('target_authorizations')
    .set({
      attempt_count: newCount,
      last_error: verifyResult.reason ?? null,
      status: newStatus,
      updated_at: new Date(nowMs),
    })
    .where('id', '=', row.id)
    .execute();

  await audit(deps, {
    tenantId: actor.tenantId,
    action: 'auth_proof.verify.failure',
    outcome: 'failure',
    actorType: 'user',
    actorId: actor.id,
    actorName: actor.email,
    resourceType: 'target',
    resourceId: targetId,
    ip,
    userAgent: ua,
    traceId,
    metadata: { method, reason: verifyResult.reason },
  });

  return c.json({ status: newStatus, reason: verifyResult.reason }, 200);
};

// ============================================================
// GET /api/v1/targets/:targetId/authorize/status
// ============================================================

export const handleAuthorizeStatus = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = requireActor(c);

  const targetIdRaw = c.req.param('targetId');
  const targetIdParsed = idSchema.safeParse(targetIdRaw);
  if (!targetIdParsed.success) return c.json({ error: 'invalid_request' }, 400);
  const targetId = targetIdParsed.data;

  const target = await resolveTarget(deps, targetId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  assertOwnership(actor.tenantId, {
    resourceType: 'target',
    resourceId: target.id,
    resourceTenantId: target.tenant_id,
  });
  assertCan(actor, 'read', 'target');

  const rows = await deps.db
    .selectFrom('target_authorizations')
    .select([
      'id',
      'method',
      'status',
      'expires_at',
      'verified_at',
      'attempt_count',
      'last_error',
      'created_at',
    ])
    .where('target_id', '=', targetId)
    .orderBy('created_at', 'desc')
    .execute();

  return c.json({
    authorizedTargetVerified: rows.some((r) => r.status === 'verified'),
    attempts: rows.map((r) => ({
      id: r.id,
      method: r.method,
      status: r.status,
      expiresAt: new Date(r.expires_at).toISOString(),
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
      attemptCount: r.attempt_count,
      lastError: r.last_error,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  });
};

// ============================================================
// GET /api/v1/targets/:targetId/authorize/email-confirm  (unauthenticated)
// ============================================================

export const handleEmailConfirm = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const nowMs = deps.nowMs?.() ?? Date.now();
  const traceId = newTraceId();

  const targetIdRaw = c.req.param('targetId');
  const tokenRaw = new URL(c.req.url).searchParams.get('token');

  const targetIdParsed = idSchema.safeParse(targetIdRaw);
  const tokenParsed = tokenSchema.safeParse(tokenRaw);

  if (!targetIdParsed.success || !tokenParsed.success) {
    return c.redirect(
      `/projects/UNKNOWN/targets/${targetIdRaw}/authorize?confirmed=0&reason=invalid_link`,
      302,
    );
  }

  const targetId = targetIdParsed.data;
  const token = tokenParsed.data;

  const tokenHash = await sha256Hex(token);

  const row = await deps.db
    .selectFrom('target_authorizations')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('target_id', '=', targetId)
    .executeTakeFirst();

  if (!row) {
    return c.redirect(
      `/projects/UNKNOWN/targets/${targetId}/authorize?confirmed=0&reason=invalid_link`,
      302,
    );
  }

  // Resolve project_id for redirect
  const target = await deps.db
    .selectFrom('targets')
    .select(['project_id'])
    .where('id', '=', targetId)
    .executeTakeFirst();

  const projectId = target?.project_id ?? 'UNKNOWN';
  const baseUrl = deps.publicBaseUrl ?? '';
  const baseRedirect = `${baseUrl}/projects/${projectId}/targets/${targetId}/authorize`;

  if (new Date(row.expires_at) <= new Date(nowMs)) {
    await deps.db
      .updateTable('target_authorizations')
      .set({ status: 'expired', updated_at: new Date(nowMs) })
      .where('id', '=', row.id)
      .execute();
    return c.redirect(`${baseRedirect}?confirmed=0&reason=expired`, 302);
  }

  if (row.status === 'verified') {
    await audit(deps, {
      tenantId: row.tenant_id,
      action: 'auth_proof.email_link.replay',
      outcome: 'failure',
      actorType: 'service',
      actorId: 'anonymous',
      actorName: 'email-confirm',
      resourceType: 'target',
      resourceId: targetId,
      traceId,
      metadata: { method: 'whois_email' },
    });
    return c.redirect(`${baseRedirect}?confirmed=1`, 302);
  }

  if (row.status !== 'pending') {
    return c.redirect(`${baseRedirect}?confirmed=0&reason=expired`, 302);
  }

  const now = new Date(nowMs);
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('target_authorizations')
      .set({
        status: 'verified',
        verified_at: now,
        consumed_at: now,
        token_plaintext: null,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    await trx
      .updateTable('targets')
      .set({ ownership_status: 'verified', updated_at: now })
      .where('id', '=', targetId)
      .where('ownership_status', '!=', 'verified')
      .execute();
  });

  await audit(deps, {
    tenantId: row.tenant_id,
    action: 'auth_proof.verify.success',
    outcome: 'success',
    actorType: 'service',
    actorId: 'anonymous',
    actorName: 'email-confirm',
    resourceType: 'target',
    resourceId: targetId,
    traceId,
    metadata: { method: 'whois_email' },
  });

  return c.redirect(`${baseRedirect}?confirmed=1`, 302);
};

// ============================================================
// Helpers
// ============================================================

const buildInstructions = (method: AuthMethod, targetValue: string, token: string) => {
  const domain = targetValue.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (method === 'dns_txt') {
    return {
      kind: method,
      txtRecord: { name: `_tensol-verify.${domain}`, value: token },
    };
  }
  if (method === 'file_upload') {
    const originUrl = targetValue.startsWith('http')
      ? targetValue.replace(/\/$/, '')
      : `https://${targetValue}`;
    return {
      kind: method,
      file: {
        url: `${originUrl}/.well-known/tensol-verify-${token}.txt`,
        body: `tensol-verify=${token}`,
      },
    };
  }
  return { kind: method };
};

const buildEmailBody = (
  token: string,
  targetId: string,
  _projectId: string,
  baseUrl: string,
): string => {
  const link = `${baseUrl}/api/v1/targets/${targetId}/authorize/email-confirm?token=${token}`;
  return [
    'Tensol — подтверждение прав на домен / Domain authorization',
    '',
    'RU: Для подтверждения прав на домен перейдите по ссылке:',
    link,
    '',
    'EN: To confirm domain ownership, follow the link:',
    link,
    '',
    'Ссылка действительна 24 часа. / Link is valid for 24 hours.',
  ].join('\n');
};
