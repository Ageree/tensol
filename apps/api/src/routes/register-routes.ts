// Route registration — wires every Sprint 3+ route into a Hono app.
//
// Lives outside factory.ts so route handlers can pull all of their deps
// without a circular import (factory.ts owns SessionRepo creation).

import type { Hono } from 'hono';
import { idempotency } from '../middleware/idempotency.ts';
import type { SessionEnv } from '../middleware/session.ts';
import { tenantGuard } from '../middleware/tenant-guard.ts';
import { handleTestResource } from './_test/resource.ts';
import {
  handleApproveAssessment,
  handleAssessmentArtifacts,
  handleAssessmentEngine,
  handleAssessmentStatus,
  handleAssessmentTimeline,
  handleCancelAssessment,
  handleCreateAssessment,
  handleGetAssessment,
  handleListAssessments,
  handlePatchAssessment,
  handlePauseAssessment,
  handleResumeAssessment,
  handleStartAssessment,
  handleSubmitAssessment,
} from './assessments/assessments.ts';
import { handleListAuditEvents } from './audit/events.ts';
import { handleLoginMfa } from './auth/login-mfa.ts';
import { handleLogin } from './auth/login.ts';
import { handleLogout } from './auth/logout.ts';
import { handleMe } from './auth/me.ts';
import { handleMfaEnable } from './auth/mfa-enable.ts';
import { handleMfaVerify } from './auth/mfa-verify.ts';
import { handlePasswordResetConfirm } from './auth/password-reset-confirm.ts';
import { handlePasswordResetRequest } from './auth/password-reset-request.ts';
import { handleRegister } from './auth/register.ts';
import {
  handleArchiveProject,
  handleCreateProject,
  handleGetProject,
  handleListProjects,
  handlePatchProject,
  handleProjectSummary,
} from './projects/projects.ts';
import type { RouteDeps } from './shared.ts';
import {
  handleCreateTarget,
  handleDeleteTarget,
  handleGetTarget,
  handleListObservations,
  handleListTargets,
  handleOwnershipProof,
  handlePatchTarget,
} from './targets/targets.ts';

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

  // Sprint 4 A14 — per-tenant audit-events read API.
  app.get('/api/v1/audit-events', tenantGuard(), (c) => handleListAuditEvents(deps, c));

  // Sprint 5 §5.2 — projects.
  app.get('/api/v1/projects', tenantGuard(), (c) => handleListProjects(deps, c));
  app.post('/api/v1/projects', tenantGuard(), (c) => handleCreateProject(deps, c));
  app.get('/api/v1/projects/:id', tenantGuard(), (c) => handleGetProject(deps, c));
  app.patch('/api/v1/projects/:id', tenantGuard(), (c) => handlePatchProject(deps, c));
  app.delete('/api/v1/projects/:id', tenantGuard(), (c) => handleArchiveProject(deps, c));
  app.get('/api/v1/projects/:id/summary', tenantGuard(), (c) => handleProjectSummary(deps, c));

  // Sprint 5 §5.3 — targets.
  app.get('/api/v1/projects/:projectId/targets', tenantGuard(), (c) => handleListTargets(deps, c));
  app.post('/api/v1/projects/:projectId/targets', tenantGuard(), (c) =>
    handleCreateTarget(deps, c),
  );
  app.get('/api/v1/targets/:id', tenantGuard(), (c) => handleGetTarget(deps, c));
  app.patch('/api/v1/targets/:id', tenantGuard(), (c) => handlePatchTarget(deps, c));
  app.delete('/api/v1/targets/:id', tenantGuard(), (c) => handleDeleteTarget(deps, c));
  app.post('/api/v1/targets/:id/ownership-proof', tenantGuard(), (c) =>
    handleOwnershipProof(deps, c),
  );
  app.get('/api/v1/targets/:id/observations', tenantGuard(), (c) =>
    handleListObservations(deps, c),
  );

  // Sprint 5 §5.4 — assessments.
  // Idempotency-Key REQUIRED on every state-transition POST (R6); create POSTs
  // do not use the middleware (uniqueness guards already prevent duplicate
  // creates server-side). The idempotency middleware runs AFTER tenantGuard so
  // the actor is available for tenant-scoped cache lookups.
  const idem = idempotency({ repos: deps.repos });
  app.get('/api/v1/projects/:projectId/assessments', tenantGuard(), (c) =>
    handleListAssessments(deps, c),
  );
  app.post('/api/v1/projects/:projectId/assessments', tenantGuard(), (c) =>
    handleCreateAssessment(deps, c),
  );
  app.get('/api/v1/assessments/:id', tenantGuard(), (c) => handleGetAssessment(deps, c));
  app.patch('/api/v1/assessments/:id', tenantGuard(), (c) => handlePatchAssessment(deps, c));
  app.post('/api/v1/assessments/:id/submit', tenantGuard(), idem, (c) =>
    handleSubmitAssessment(deps, c),
  );
  app.post('/api/v1/assessments/:id/approve', tenantGuard(), idem, (c) =>
    handleApproveAssessment(deps, c),
  );
  app.post('/api/v1/assessments/:id/start', tenantGuard(), idem, (c) =>
    handleStartAssessment(deps, c),
  );
  app.post('/api/v1/assessments/:id/pause', tenantGuard(), idem, (c) =>
    handlePauseAssessment(deps, c),
  );
  app.post('/api/v1/assessments/:id/resume', tenantGuard(), idem, (c) =>
    handleResumeAssessment(deps, c),
  );
  app.post('/api/v1/assessments/:id/cancel', tenantGuard(), idem, (c) =>
    handleCancelAssessment(deps, c),
  );
  app.get('/api/v1/assessments/:id/status', tenantGuard(), (c) => handleAssessmentStatus(deps, c));
  app.get('/api/v1/assessments/:id/timeline', tenantGuard(), (c) =>
    handleAssessmentTimeline(deps, c),
  );
  app.get('/api/v1/assessments/:id/artifacts', tenantGuard(), (c) =>
    handleAssessmentArtifacts(deps, c),
  );
  app.get('/api/v1/assessments/:id/engine', tenantGuard(), (c) => handleAssessmentEngine(deps, c));
};
