# Feature Specification: Tensol Backend v2 — Clean-Slate Redesign

**Feature Branch**: `001-backend-v2`

**Created**: 2026-05-18

**Status**: Draft

**Input**: Replace bloated multi-package backend with a thin single-binary SaaS shell over the Decepticon pentest engine. Three load-bearing invariants stay: target ownership proof, signed audit log, per-scan egress isolation. Everything else is removed.

## User Scenarios & Testing

### User Story 1 — End-to-end first scan (Priority: P1)

A security-conscious B2B operator signs in by email, registers a target they own, proves ownership of that target, and runs an AI-driven pentest against it. They expect a signed, reviewable report of findings within roughly 15–30 minutes.

**Why this priority**: This is the entire reason the product exists. Without it, no other functionality has value. Every other story exists to support, harden, or recover from this one.

**Independent Test**: Stand up the backend with a fake VPS provider that returns canned findings, sign in with an email, register a target, prove ownership against a local DNS fixture, start a scan, and verify the report appears with all findings + a verifiable audit chain.

**Acceptance Scenarios**:

1. **Given** a new visitor on the platform, **When** they submit their email, **Then** they receive a one-time login link valid for fifteen minutes and a single use.
2. **Given** a signed-in operator with no projects, **When** they create a project and add a target URL, **Then** the target is recorded with an "unverified" status and is not eligible for scanning.
3. **Given** an unverified target, **When** the operator requests ownership verification, **Then** the system issues a unique challenge token and presents three independent proof methods (DNS TXT record, file at a well-known path, HTML meta tag).
4. **Given** the operator has placed the challenge on the target, **When** they request verification, **Then** the system independently confirms the challenge by at least one method and marks the target verified for ninety days.
5. **Given** a verified target, **When** the operator starts a scan with a chosen profile, **Then** the scan enters the queue and a dedicated ephemeral scanning environment is provisioned for it.
6. **Given** a running scan, **When** the scanning environment finishes the assessment, **Then** the platform receives findings via an authenticated callback and the operator can review them in the report view.
7. **Given** a completed scan, **When** the operator opens the audit timeline for that scan, **Then** they see every state-changing event in chronological order, and an out-of-band verifier can confirm the chain has not been tampered with.

---

### User Story 2 — Refuse to scan unverified targets (Priority: P1)

The platform must never run a pentest against a resource the operator has not proven they own. This is a legal, contractual, and ethical line that cannot be crossed even by accident.

**Why this priority**: A single unauthorized scan is an existential risk to the business. This rule must hold even if every other feature is broken.

**Independent Test**: Try to start a scan against a target with `status='unverified'`; expect a 403-class refusal with an explanation of how to verify ownership, and no scan record is created.

**Acceptance Scenarios**:

1. **Given** an unverified target, **When** the operator attempts to start a scan, **Then** the system refuses the request, no scan record is created, no environment is provisioned, and the response explains the ownership-proof requirement.
2. **Given** a target whose verification is older than ninety days, **When** the operator attempts to start a scan, **Then** the system treats the target as unverified again and refuses.
3. **Given** any rejected scan attempt due to verification, **When** the audit log is inspected, **Then** the refusal is recorded as a signed event (so abuse attempts are forensically discoverable).

---

### User Story 3 — Per-scan egress isolation (Priority: P1)

Every scan must originate from a dedicated network identity that exists only for the duration of that scan, then is destroyed. No two scans share an outbound IP.

**Why this priority**: A shared egress IP means one banned IP halts the platform; it also leaks cross-customer traffic patterns to a customer's WAF/SIEM. Egress isolation is a contractual claim of the product.

**Independent Test**: Start two scans in parallel; verify two distinct VPS records are created with two distinct IPs; after both complete, verify both VPS records are marked destroyed and the provider confirms teardown.

**Acceptance Scenarios**:

1. **Given** two scans started within the same minute, **When** both are provisioned, **Then** each receives a distinct ephemeral compute environment with a unique outbound IP.
2. **Given** a scan that has completed (or failed, or was cancelled), **When** five minutes have passed since terminal state, **Then** the associated environment has been destroyed and is no longer reachable.
3. **Given** an operator who repeatedly scans the same target, **When** their next scan begins, **Then** none of the previous environments are reused.

---

### User Story 4 — Tamper-evident audit log (Priority: P1)

Every state-changing operation in the system writes a signed entry into an append-only audit log. The chain is independently verifiable, so a compliance reviewer can be confident no event was added, removed, or altered after the fact.

**Why this priority**: Audit is the product's compliance and forensic backbone. Without it, the SaaS positioning collapses for any regulated buyer.

**Independent Test**: Perform a series of state-changing actions (login, project create, ownership verified, scan started, finding emitted, scan completed). Run the chain verifier. Mutate one row in the database. Run the verifier again. Expect the second run to detect the tampering at the mutated row.

**Acceptance Scenarios**:

1. **Given** any state-changing action (authentication success, ownership change, scan lifecycle event, finding emission), **When** the action completes, **Then** an audit row is written and signed before the response returns.
2. **Given** a complete audit log, **When** an out-of-band verifier walks the chain, **Then** every row's signature is reproducible from the previous row's signature plus the canonical message.
3. **Given** a tampered audit row, **When** the chain verifier runs, **Then** the tampering is detected and the row at which the chain breaks is reported.
4. **Given** an operator viewing their scan's audit timeline, **When** they request the timeline via the platform, **Then** they see a human-readable chronological list of events without the raw signatures (those are kept in storage).

---

### User Story 5 — Resilience to backend restart (Priority: P2)

A backend restart during an active scan must not orphan the scan or duplicate the work. On startup, the system reconciles any "running" scans against their live scanning environments.

**Why this priority**: A solo-operator setup will restart for deploys and patches. Without reconciliation, every restart silently corrupts scan state. Important for trust but not strictly day-one.

**Independent Test**: Start a scan, kill the backend mid-scan while the scan environment keeps running, restart the backend, then send the completion callback. Verify the scan completes correctly and the operator sees the report.

**Acceptance Scenarios**:

1. **Given** the backend has just restarted, **When** scans are in the `running` state, **Then** for each one the system queries the scan environment for liveness within 60 seconds of startup.
2. **Given** a scan environment that is still working, **When** reconciliation runs, **Then** the scan continues normally and no duplicate work is initiated.
3. **Given** a scan environment that is unreachable after reconciliation retries, **When** the maximum reconciliation window is exceeded, **Then** the scan is marked failed with a clear reason and the environment is torn down.
4. **Given** a scan callback that arrives before reconciliation has run, **When** it is received, **Then** it is processed normally and the scan completes.

---

### User Story 6 — Recover from a failed scan environment (Priority: P2)

When the scan environment crashes, hangs, or is destroyed externally, the scan must not stay "running" forever; it must be moved to a terminal state and the operator must be notified.

**Why this priority**: Without a watchdog, scans become zombies that consume quota and confuse operators. Important after we have the happy path working.

**Independent Test**: Start a scan, then deliberately make the scan environment stop responding (kill the agent, disconnect, or destroy the VPS). After the failure-detection window, verify the scan moves to `failed`, the environment is torn down, and an audit event records the reason.

**Acceptance Scenarios**:

1. **Given** a scan whose environment has not sent a callback for thirty minutes, **When** the watchdog runs, **Then** the system probes the environment for liveness.
2. **Given** a liveness probe that fails, **When** retries are exhausted, **Then** the scan is marked failed with reason "agent_unresponsive" and the environment is torn down.
3. **Given** any forced state transition by the watchdog, **When** the audit log is reviewed, **Then** the watchdog action is signed and labeled clearly.

---

### User Story 7 — Operator cancels an in-progress scan (Priority: P3)

The operator can cancel a scan that is queued or running. The system stops it gracefully and tears down the environment.

**Why this priority**: Useful operator control but not blocking. The watchdog will eventually catch stalled scans even without an explicit cancel.

**Independent Test**: Start a scan, cancel it before completion, verify the environment is destroyed and the scan moves to a `cancelled` terminal state with an audit event.

**Acceptance Scenarios**:

1. **Given** a queued scan, **When** the operator cancels it, **Then** the scan moves to `cancelled` and any pending provisioning is aborted.
2. **Given** a running scan, **When** the operator cancels it, **Then** the environment is signaled to stop, the scan moves to `cancelled`, and the environment is destroyed within ten minutes.
3. **Given** a scan in a terminal state (completed/failed/cancelled), **When** cancel is attempted, **Then** the request is rejected with a clear "already terminal" message and no audit event is written.

---

### Edge Cases

- A returning operator submits their email; the system MUST issue a fresh magic link without revealing whether the email is new or existing (no enumeration).
- The operator submits an invalid target URL (malformed, private IP, localhost, internal-only host); the system MUST reject it at input boundary with a clear message.
- The operator tries to verify ownership after the challenge has expired (older than 24 hours); the system MUST refuse and require a new challenge.
- The same target receives two parallel scans; each MUST be isolated and complete independently with its own environment and findings.
- The operator cancels a scan while its environment is mid-provisioning; teardown MUST happen as soon as provisioning settles, never leaving an orphan environment.
- The VPS provider's API is unreachable when a scan is queued; the system MUST retry with exponential backoff and, after a bounded number of attempts, mark the scan failed.
- A scan callback is delivered more than once (retry from the scan environment); the system MUST be idempotent — duplicate findings are not stored twice.
- A callback arrives with an invalid signature; the system MUST reject it, record the rejection in the audit log, and leave the scan state untouched.
- A scan profile asks for a capability the engine no longer supports; the system MUST fail the scan early with a clear reason rather than partially running.

## Requirements

### Functional Requirements

**Authentication & Session**

- **FR-001**: The system MUST allow an operator to sign in by submitting an email address; the system delivers a one-time login link to that email.
- **FR-002**: The login link MUST expire fifteen minutes after issuance and MUST be usable exactly once.
- **FR-003**: A successful login MUST create a session valid for thirty days; the session MUST be revocable by logout.
- **FR-004**: The system MUST not disclose whether a given email is registered.

**Projects & Targets**

- **FR-005**: An operator MUST be able to create and delete projects scoped to their own account, and MUST NOT see other operators' projects.
- **FR-006**: An operator MUST be able to add targets (URLs) to projects they own. New targets begin unverified.
- **FR-007**: The system MUST reject URLs that are malformed, point to private IPs, refer to localhost, or otherwise pose obvious safety problems, at the moment of submission.

**Target Ownership Proof**

- **FR-008**: The system MUST issue an ownership challenge on operator request for any of their unverified targets; the challenge MUST be unique per request.
- **FR-009**: The system MUST accept verification by any of three methods: a DNS TXT record at the apex of the target, a file at a well-known HTTP path on the target, or an HTML meta tag in the target's root page.
- **FR-010**: Verification MUST be performed by the system independently — the operator's claim of having placed the challenge is not enough; the system must observe the challenge itself.
- **FR-011**: A verified target MUST remain verified for ninety days; afterwards re-verification is required before another scan can be started.
- **FR-012**: A failed verification attempt MUST report which methods were checked and which did not match, so the operator can correct their setup.
- **FR-013**: A challenge MUST expire twenty-four hours after issuance; verification attempts after expiry MUST be refused.

**Scans**

- **FR-014**: An operator MUST be able to start a scan only against a verified target they own; any other case is refused.
- **FR-015**: The operator MUST choose a scan profile from a fixed list (recon, standard, max) at scan-start time.
- **FR-016**: Each scan MUST be executed in its own isolated environment that is created at scan start and destroyed after the scan reaches a terminal state.
- **FR-017**: Two scans in flight MUST never share an outbound network identity.
- **FR-018**: An operator MUST be able to view their scans (own scans only): the list, individual scan detail, and the findings produced.
- **FR-019**: An operator MUST be able to cancel a scan that has not yet reached a terminal state.
- **FR-020**: A scan that does not produce a completion signal within thirty minutes MUST be probed for liveness; if the environment is unresponsive, the scan MUST be marked failed and the environment torn down.

**Findings**

- **FR-021**: A finding MUST carry a severity (one of: critical, high, medium, low, info), a short title, a human-readable body, optional evidence, and a timestamp.
- **FR-022**: Findings MUST be read-only for the operator; no edits, deletes, or severity changes are permitted.
- **FR-023**: Duplicate finding submissions for the same scan MUST be detected and ignored (idempotency).

**Audit Log**

- **FR-024**: Every state-changing operation in the system MUST produce a signed audit entry before the operation is considered complete.
- **FR-025**: The audit log MUST form a verifiable chain: each entry's signature MUST cover the previous entry's signature, so out-of-order or removed entries are detectable.
- **FR-026**: The audit log MUST be append-only; no UI or API path may modify or delete an existing entry.
- **FR-027**: An operator MUST be able to view a human-readable audit timeline for any of their own scans.
- **FR-028**: The signing material MUST never be exposed in any API response.

**Scan-environment Callback**

- **FR-029**: The system MUST accept scan completion callbacks from the isolated scan environment over an authenticated channel; unauthenticated callbacks MUST be rejected and logged.
- **FR-030**: Callbacks for unknown or already-terminal scans MUST be rejected with a clear error and an audit entry.
- **FR-031**: On a successful callback, all delivered findings MUST be stored, the scan MUST move to completed, and teardown of the environment MUST be initiated.
- **FR-032**: On a failure-status callback, the scan MUST move to failed with the reason supplied and teardown MUST be initiated.

**Operational Resilience**

- **FR-033**: After a backend restart, the system MUST reconcile every non-terminal scan against its environment within sixty seconds of startup.
- **FR-034**: Scans whose environments cannot be reconciled within five reconciliation cycles MUST be moved to failed and torn down.

### Key Entities

- **Operator**: A signed-in user. Owns projects, targets, and scans. Only sees their own data.
- **Project**: A user-named grouping of targets owned by a single operator.
- **Target**: A URL the operator intends to assess. Carries a verification status and last-verified timestamp.
- **Ownership Challenge**: A per-target proof artifact. Has a unique token, methods (DNS / file / meta-tag), creation time, expiry, and state.
- **Scan**: A single pentest run against one verified target. Has a profile, lifecycle state (queued / running / completed / failed / cancelled), timing, and links to findings + audit entries.
- **Finding**: A vulnerability or observation produced by the engine. Severity, title, body, optional evidence, immutable once stored.
- **Audit Entry**: A signed record of a state-changing event. Forms a chain via the previous entry's signature.
- **Scan Environment**: The ephemeral compute environment provisioned for one scan. Has a provider, provider-specific ID, outbound IP, lifecycle state, and signing material for its callback.

## Success Criteria

### Measurable Outcomes

- **SC-001**: From "create account" to "first finding visible" takes no longer than thirty-five minutes for a happy-path target, including ownership verification time.
- **SC-002**: An operator who already has a verified target can start a new scan in under thirty seconds (from button click to "scan running" state).
- **SC-003**: No scan ever runs against a target whose ownership has not been independently verified by the system (verified by review of the audit log over any one-month window).
- **SC-004**: No two scans in flight at the same time share an outbound network identity (verified by environment records and provider API over any one-month window).
- **SC-005**: One hundred percent of state-changing operations produce an audit entry, and the chain verifies without breaks over any one-month window.
- **SC-006**: After a backend restart, every previously-running scan is either reconciled to a correct live state or moved to a terminal state with reason within five minutes of the restart.
- **SC-007**: A scan whose environment dies is moved to a terminal state within forty-five minutes of the failure, with the audit entry naming the failure cause.
- **SC-008**: Ninety-five percent of read-only operator requests (list scans, get scan detail, view audit timeline) return in under one hundred milliseconds.
- **SC-009**: The platform can run ten concurrent scans without degrading read-only request latency past the SC-008 target.
- **SC-010**: Eighty percent of automated test cases pass at every commit on the main branch (combined unit + integration + end-to-end).

## Assumptions

- The Decepticon engine remains the pentest implementation and is not modified by this work; the system treats it as a black box invoked over its container interface.
- One operator equals one organization for v2; multi-tenant collaboration is explicitly out of scope.
- The product runs as a single process on a single machine; high availability and horizontal scaling are out of scope.
- A single VPS provider is sufficient for v2; the choice (Hetzner, DigitalOcean, or GCP) is made during planning and locked.
- Outbound email delivery (for magic links) is via a managed provider; the specific provider choice is made during planning.
- The operator is technically competent enough to place a DNS TXT record, a file, or a meta tag on their target.
- Real-time progress streaming (server-sent events, WebSocket) is not required for v2; the operator polls the scan record.
- Action-cap and cost-cap are enforced inside the Decepticon engine via its environment configuration; the platform does not duplicate them as a separate layer.
- The previous backend's data (v1) is not migrated. The v1 git history is the rollback path.

## Out of Scope

- Multi-tenant organizations, shared projects, role-based access control beyond owner-only.
- Real-time progress streaming to the browser.
- Findings triage workflow, comments, status changes, deduplication across scans.
- Custom scan profiles beyond the fixed three (recon, standard, max).
- Integration with external ticketing or messaging systems.
- Action-cap or cost-cap as a platform-level layer.
- High-availability deployment, multi-region, horizontal scaling.
- Self-service billing.
