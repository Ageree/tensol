// Route registration — wires every Sprint 3 auth route into a Hono app.
//
// Lives outside factory.ts so route handlers can pull all of their deps
// without a circular import (factory.ts owns SessionRepo creation).

import type { Hono } from 'hono';
import type { SessionEnv } from '../middleware/session.ts';
import { tenantGuard } from '../middleware/tenant-guard.ts';
import { handleTestResource } from './_test/resource.ts';
import { handleLoginMfa } from './auth/login-mfa.ts';
import { handleLogin } from './auth/login.ts';
import { handleLogout } from './auth/logout.ts';
import { handleMe } from './auth/me.ts';
import { handleMfaEnable } from './auth/mfa-enable.ts';
import { handleMfaVerify } from './auth/mfa-verify.ts';
import { handlePasswordResetConfirm } from './auth/password-reset-confirm.ts';
import { handlePasswordResetRequest } from './auth/password-reset-request.ts';
import { handleRegister } from './auth/register.ts';
import type { RouteDeps } from './shared.ts';

export const registerRoutes = (app: Hono<SessionEnv>, deps: RouteDeps): void => {
  // Bootstrap (no auth — gated by token + consume-once).
  app.post('/auth/register', (c) => handleRegister(deps, c));

  // Step-1 + step-2 login (no auth — issues the cookie).
  app.post('/auth/login', (c) => handleLogin(deps, c));
  app.post('/auth/login/mfa', (c) => handleLoginMfa(deps, c));

  // Logout — runs even on expired sessions (clears cookie idempotently).
  app.post('/auth/logout', (c) => handleLogout(deps, c));

  // Authenticated endpoints — guarded by tenantGuard.
  app.get('/auth/me', tenantGuard(), (c) => handleMe(deps, c));
  app.post('/auth/mfa/enable', tenantGuard(), (c) => handleMfaEnable(deps, c));
  app.post('/auth/mfa/verify', tenantGuard(), (c) => handleMfaVerify(deps, c));

  // Password reset — request is unauthenticated, confirm is unauthenticated
  // (token is the proof of possession).
  app.post('/auth/password/reset/request', (c) => handlePasswordResetRequest(deps, c));
  app.post('/auth/password/reset/confirm', (c) => handlePasswordResetConfirm(deps, c));

  // Sprint-3-only IDOR fixture endpoint.
  app.get('/_test/resource/:id', tenantGuard(), (c) => handleTestResource(deps, c));
};
