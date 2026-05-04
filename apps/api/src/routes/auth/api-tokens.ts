import type { Context } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../../middleware/session.ts';
import type { RouteDeps } from '../shared.ts';

const createTokenSchema = z.object({ name: z.string().min(1).max(128) }).strict();

// SHA-256 hex using Web Crypto API (available in Bun runtime).
async function sha256Hex(data: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// POST /api/v1/auth/api-tokens
// =============================================================================

export const handleCreateApiToken = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid_body' }, 400);
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { name } = parsed.data;

  // Generate 32-byte cryptographically random token as 64-char hex string.
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const plaintext = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const tokenHash = await sha256Hex(plaintext);

  const inserted = await deps.db
    .insertInto('api_tokens')
    .values({
      tenant_id: actor.tenantId,
      user_id: actor.id,
      name,
      token_hash: tokenHash,
      last_used_at: null,
      expires_at: null,
    })
    .returning(['id', 'name', 'created_at'])
    .executeTakeFirstOrThrow();

  // No audit emit — api_token.* not in AUDIT_ACTIONS (v1 gap per Z.5: +0 new actions).

  return c.json(
    {
      token: plaintext,
      id: inserted.id,
      name: inserted.name,
      created_at: inserted.created_at,
    },
    201,
  );
};

// =============================================================================
// GET /api/v1/auth/api-tokens
// =============================================================================

export const handleListApiTokens = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthorized' }, 401);

  const rows = await deps.db
    .selectFrom('api_tokens')
    .select(['id', 'name', 'last_used_at', 'expires_at', 'created_at'])
    .where('tenant_id', '=', actor.tenantId)
    .where('user_id', '=', actor.id)
    .orderBy('created_at', 'desc')
    .execute();

  const tokens = rows.map((r) => ({
    id: r.id,
    name: r.name,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));

  return c.json({ tokens });
};

// =============================================================================
// DELETE /api/v1/auth/api-tokens/:tokenId
// =============================================================================

export const handleDeleteApiToken = async (
  deps: RouteDeps,
  c: Context<SessionEnv>,
): Promise<Response> => {
  const actor = c.get('actor');
  if (!actor) return c.json({ error: 'unauthorized' }, 401);

  const tokenId = c.req.param('tokenId');
  if (!tokenId) return c.json({ error: 'invalid_token_id' }, 400);

  const deleted = await deps.db
    .deleteFrom('api_tokens')
    .where('id', '=', tokenId)
    .where('tenant_id', '=', actor.tenantId)
    .where('user_id', '=', actor.id)
    .returning(['id'])
    .executeTakeFirst();

  if (!deleted) return c.json({ error: 'not_found' }, 404);

  return c.json({ id: deleted.id });
};
