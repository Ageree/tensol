# Auth rotation runbook

> Operational procedures for rotating CyberStrike Hybrid auth secrets and
> recovering from incidents. Owner: security on-call. Updated: Sprint 3.

## When to rotate

| Trigger                                              | Action                                          |
|------------------------------------------------------|-------------------------------------------------|
| `SESSION_SECRET` exposure (env var leak, repo leak)  | §1 Session secret rotation                      |
| `BOOTSTRAP_TOKEN` exposure                           | §2 Bootstrap token rotation                     |
| Suspected mass session compromise                    | §3 Force-logout-all-sessions                    |
| Single user reports unauthorized access              | §4 Single-user session purge + password reset   |
| MFA secret database leak                             | §5 Bulk MFA re-enrollment                       |
| Password database leak                               | §6 Bulk password reset                          |
| Production MFA encryption key compromise (Sprint 7+) | §7 KMS DEK rotation (placeholder)               |

## §1 Session secret rotation

`SESSION_SECRET` is read by `packages/config` at boot and signs no payloads
in slice 3 (sessions are server-side, opaque). Rotation does NOT invalidate
existing sessions — it just changes the value future deployments will load.

**Steps:**
1. Generate a new 64-char hex secret: `openssl rand -hex 32`.
2. Update the env in your secret store (Vault / SSM / etc.).
3. Roll the API deployment.
4. Optionally: trigger §3 to force-logout-all-sessions. Sessions outlive
   secret rotation by design (slice limitation).

## §2 Bootstrap token rotation

`BOOTSTRAP_TOKEN` is consumed exactly once (C21b) — after the first
`/auth/register` succeeds, the value is irrelevant. Rotation is only useful
in two cases:

a) The platform_settings row was reset (rare — usually means a fresh DB).
b) An attacker may have observed the bootstrap token before consumption.

**Steps:**
1. Generate a new ≥32-byte hex token: `openssl rand -hex 32`.
2. Update env. Roll the API deployment.
3. If `platform_settings.bootstrap_consumed_at IS NOT NULL`, ignore — no
   further bootstrap registrations are possible regardless of token value.

## §3 Force-logout-all-sessions

Hard delete every row in `user_sessions`. Every cookie the API ever issued
becomes a 401 on next request.

```sql
BEGIN;
DELETE FROM user_sessions;
INSERT INTO audit_events (
  tenant_id, actor_type, actor_id, actor_name, action,
  resource_type, after_state, trace_id
)
SELECT
  '__platform_tenant_uuid__', 'service', 'system', 'security-oncall',
  'auth.logout', 'user_session', '{"outcome":"forced_global"}'::jsonb,
  gen_random_uuid()::text;
COMMIT;
```

(Replace `__platform_tenant_uuid__` with the value of `SELECT id FROM tenants WHERE slug = '__platform__'`.)

Browsers retain the cookie value but the next request will land on
`tenantGuard` → `unauthenticated` 401, prompting re-login.

## §4 Single-user session purge + password reset

User `<email>` reports unauthorized access.

```sql
WITH u AS (SELECT id FROM users WHERE email = '<email>')
DELETE FROM user_sessions WHERE user_id = (SELECT id FROM u);
```

Then trigger a password reset out-of-band:

```bash
curl -X POST https://<api-host>/auth/password/reset/request \
  -H 'content-type: application/json' \
  -d '{"email":"<email>"}'
```

In `local`, the response body returns the plaintext token. In production
the token lands in `audit_events.after_state.token_hash_prefix` for the
matching `auth.password.reset.request` row — the operator looks up the row
and pages the user via the out-of-band channel.

## §5 Bulk MFA re-enrollment

Run when the `mfa_secrets.secret_encrypted` column is suspected leaked. In
slice 3, this column is plaintext (R9 limitation).

```sql
BEGIN;
UPDATE users SET mfa_enrolled = false;
DELETE FROM mfa_secrets;
DELETE FROM user_sessions;  -- force re-login + re-enrollment
COMMIT;
```

Notify users out-of-band that they must re-scan a fresh QR code on next login.

## §6 Bulk password reset

```sql
BEGIN;
DELETE FROM user_sessions;
-- Mark every account 'pending'; the next /auth/login returns canonical
-- 401 (status != 'active' branch) and the operator force-issues reset
-- tokens out-of-band.
UPDATE users SET status = 'pending';
COMMIT;
```

Then for each user:

```bash
curl -X POST https://<api-host>/auth/password/reset/request \
  -H 'content-type: application/json' \
  -d '{"email":"<email>"}'
```

## §7 KMS DEK rotation (Sprint 7+ — placeholder)

Once R9 lands (per-tenant KMS-rooted DEK for `mfa_secrets.secret_encrypted`),
DEK rotation will be a one-shot migration:

1. Mint a new DEK version via the KMS.
2. For each `mfa_secrets` row: decrypt with the old DEK, re-encrypt with the
   new DEK, persist.
3. Schedule the old DEK for destruction after the audit window.

Until Sprint 7 lands, this section is a placeholder.

## Audit trail

Every action in this runbook should leave an `audit_events` row with
`actor_type='service'`, `actor_name='security-oncall'`, and a free-text
`after_state.runbook_action` value naming the section taken (e.g.
`'§3.force-logout-all-sessions'`). The append-only trigger guarantees the
row cannot be quietly removed.
