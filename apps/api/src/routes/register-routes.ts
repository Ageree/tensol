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
import { handleListAssessmentJobs } from './assessments/jobs.ts';
import { handleScopeValidate } from './assessments/scope-validate.ts';
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
import { handleSelfRegister } from './auth/self-register.ts';
import { handleBillingCheckout, handleGetSubscription } from './billing/billing.ts';
import { handleVerifyCheck, handleVerifyStart } from './domains/domain-verify.ts';
import { handleGetEvidence, handleListFindingEvidence } from './evidence/evidence.ts';
import {
  handleGetFinding,
  handleListAssessmentFindings,
  handlePatchFindingStatus,
} from './findings/findings.ts';
import {
  handleArchiveProject,
  handleCreateProject,
  handleGetProject,
  handleListProjects,
  handlePatchProject,
  handleProjectSummary,
} from './projects/projects.ts';
import { handleBuildReport, handleDownloadReport, handleGetReport } from './reports/reports.ts';
import {
  handleGetScan,
  handleLaunchScan,
  handleListScans,
  handleScanProgress,
} from './scans/scans.ts';
import type { RouteDeps } from './shared.ts';
import {
  handleCreateTarget,
  handleCreateTargetCredential,
  handleDeleteTarget,
  handleGetTarget,
  handleListObservations,
  handleListTargetCredentials,
  handleListTargets,
  handleOwnershipProof,
  handlePatchTarget,
} from './targets/targets.ts';

export const registerRoutes = (app: Hono<SessionEnv>, deps: RouteDeps): void => {
  // Bootstrap (no auth — gated by token + consume-once).
  app.post('/auth/register', (c) => handleRegister(deps, c));

  // SaaS self-registration (no auth — rate-limited per IP).
  app.post('/auth/self-register', (c) => handleSelfRegister(deps, c));

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
  // Sprint 17 B — list stored credentials (no blob/iv/authTag in response).
  app.get('/api/v1/targets/:id/credentials', tenantGuard(), (c) =>
    handleListTargetCredentials(deps, c),
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

  // Sprint 6 §5.6 — scope-engine validate endpoint. Read-only (no Idempotency-Key).
  app.post('/api/v1/assessments/:id/scope/validate', tenantGuard(), (c) =>
    handleScopeValidate(deps, c),
  );

  // Sprint 7 §5.5 A-Q-Api-3 — assessment jobs listing.
  app.get('/api/v1/assessments/:id/jobs', tenantGuard(), (c) => handleListAssessmentJobs(deps, c));

  // Sprint 11 — findings.
  app.get('/api/v1/assessments/:id/findings', tenantGuard(), (c) =>
    handleListAssessmentFindings(deps, c),
  );
  app.get('/api/v1/findings/:id', tenantGuard(), (c) => handleGetFinding(deps, c));
  app.patch('/api/v1/findings/:id/status', tenantGuard(), (c) => handlePatchFindingStatus(deps, c));

  // Sprint 11 — evidence.
  app.get('/api/v1/findings/:id/evidence', tenantGuard(), (c) =>
    handleListFindingEvidence(deps, c),
  );
  app.get('/api/v1/evidence/:id', tenantGuard(), (c) => handleGetEvidence(deps, c));

  // Sprint 16 B19 — target credentials (encrypt-at-insert, immutable).
  app.post('/api/v1/assessments/:id/target-credentials', tenantGuard(), (c) =>
    handleCreateTargetCredential(deps, c),
  );

  // Sprint 14 — reports.
  app.post('/api/v1/assessments/:id/reports', tenantGuard(), idem, (c) =>
    handleBuildReport(deps, c),
  );
  app.get('/api/v1/reports/:id', tenantGuard(), (c) => handleGetReport(deps, c));
  app.get('/api/v1/reports/:id/download', tenantGuard(), (c) => handleDownloadReport(deps, c));

  // S25 — domain ownership verification via DNS-TXT.
  app.post('/api/v1/domains/verify/start', tenantGuard(), (c) => handleVerifyStart(deps, c));
  app.get('/api/v1/domains/verify/check', tenantGuard(), (c) => handleVerifyCheck(deps, c));

  // S26 — scan launch + live progress. POST /scans creates + runs state machine
  // in one request; idem prevents duplicate assessment rows on retry (R6/§5.7).
  app.post('/api/v1/scans', tenantGuard(), idem, (c) => handleLaunchScan(deps, c));
  app.get('/api/v1/scans', tenantGuard(), (c) => handleListScans(deps, c));
  app.get('/api/v1/scans/:id', tenantGuard(), (c) => handleGetScan(deps, c));
  app.get('/api/v1/scans/:id/progress', tenantGuard(), (c) => handleScanProgress(deps, c));

  // S26 — billing stub. POST checkout is a state-mutating call; idem prevents
  // duplicate subscription UPSERT races on retry.
  app.post('/api/v1/billing/checkout', tenantGuard(), idem, (c) => handleBillingCheckout(deps, c));
  app.get('/api/v1/billing/subscription', tenantGuard(), (c) => handleGetSubscription(deps, c));
};
