# Feature Specification: Blackbox Pentest MVP

**Feature Branch**: `002-blackbox-mvp`

**Created**: 2026-05-19

**Status**: Draft

**Input**: User description: "Tensol Blackbox MVP — Quick (self-serve free) + Deep (lead-gen via Telegram) tracks, clean-slate wizard architecture per design doc 2026-05-19-blackbox-mvp-design.md"

**Source design**: `docs/superpowers/specs/2026-05-19-blackbox-mvp-design.md`

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Run a free Quick blackbox scan against your own site (Priority: P1)

A web operator wants to know what surface-level vulnerabilities an outside attacker would see on their site. They visit the platform, sign up with their email, enter their domain, prove they own it, and within ~15 minutes (including DNS propagation) receive a list of findings with severity, CWE/CVSS scoring, and reproduction details.

**Why this priority**: This is the entire product. Without it there's nothing to sell. Free Quick is also the primary lead-magnet driving signups for both future paid Quick scans and Deep inquiries.

**Independent Test**: A new user with a domain they control can complete signup → scan launch → receive at least one finding (or "no findings" confirmation) without any operator intervention. End-to-end success measurable in a single Playwright run.

**Acceptance Scenarios**:

1. **Given** a new visitor on the landing page, **When** they click "Try Quick free" and enter a valid email, **Then** they receive a sign-in link via email and complete sign-in.
2. **Given** a signed-in user, **When** they enter a domain they control and follow the wizard through Attack Surface → Safety → Verify Domain → Launch, **Then** they reach a live progress view of their running scan.
3. **Given** a user has added the required ownership-verification record to their domain's DNS, **When** the platform checks for it, **Then** verification succeeds within 5 minutes and the Launch step unlocks.
4. **Given** a user with no Quick scan in the past 7 days clicks Launch, **When** they confirm, **Then** the scan starts and they see live progress events streaming.
5. **Given** a Quick scan completes successfully, **When** the user opens the findings page, **Then** they see each finding with severity, title, target, and reproduction details.
6. **Given** a completed Quick scan, **When** the user requests the PDF report, **Then** they receive a downloadable PDF containing executive summary plus full finding details.
7. **Given** a completed Quick scan, **When** ~1 minute has passed, **Then** the user has received an email with a link to the dashboard and the PDF attached.

---

### User Story 2 — Request a Deep engagement when Quick isn't enough (Priority: P2)

An organization realizes they need a deeper assessment than a surface scan — authenticated testing, IDOR, business-logic flaws, full kill chain. They visit the pricing page, click "Request Deep audit", fill a structured inquiry form (company, contact, target inventory, budget, scope, desired date), and submit. The operator team is alerted in real time, contacts them within 24 hours, and conducts the engagement off-platform.

**Why this priority**: Deep is the high-margin track that funds the business. Even before automated Deep is built, the inquiry funnel must work — otherwise leads are lost.

**Independent Test**: Submit the Deep inquiry form (anonymously or signed-in). Operator receives a structured message in their dedicated channel within 60 seconds. Inquiry record is persisted with status `new` and is retrievable.

**Acceptance Scenarios**:

1. **Given** any visitor (signed-in or not) on the Pricing page, **When** they click "Request Deep audit", **Then** they reach a form with all required fields.
2. **Given** a signed-in user, **When** they open the Deep inquiry form, **Then** their email and name are pre-filled.
3. **Given** the user has filled all required fields and accepted the data-processing consent, **When** they submit, **Then** the form succeeds, they see a "Заявка получена. Свяжемся в течение 24 часов" confirmation page, and the operator team receives a structured notification.
4. **Given** the user did not accept consent, **When** they try to submit, **Then** the submission is rejected with a clear error.
5. **Given** a submitted inquiry, **When** the operator views it in the admin tooling, **Then** all fields (company, contact, domain, scope, budget, desired date) are visible verbatim.

---

### User Story 3 — Browse past scans and re-download reports (Priority: P3)

A returning user wants to see scans they've run before, check what was found, and re-download a report — perhaps to share with their team or attach to their own compliance documentation.

**Why this priority**: Retention + revisiting drives long-term engagement. Day-one is about signups; day-7 is about coming back. Without this, MVP feels disposable.

**Independent Test**: A user with at least one historical scan can navigate to a list of their scans, click any one, see its findings, and download its report — all without re-running a scan.

**Acceptance Scenarios**:

1. **Given** a signed-in user with at least one prior scan, **When** they visit the dashboard, **Then** they see a list of their scans with status, target, date, and tier.
2. **Given** the user clicks on a completed scan, **When** the findings page loads, **Then** they see the same findings detail page as immediately post-scan.
3. **Given** the report PDF is still within retention window (30 days), **When** the user clicks Download, **Then** the report downloads successfully.
4. **Given** the report has aged past retention, **When** the user clicks Download, **Then** they receive a clear message that the report has expired plus a one-click "regenerate" option (free, no new scan).

---

### Edge Cases

- **DNS verification never succeeds**: User enters domain but cannot or does not add the TXT record. After 30 minutes the order moves to a failed state with a clear message and a retry option. No free-Quick quota is consumed.
- **Free-Quick quota exhausted**: User has used their free scan in the past 7 days and tries to launch another. They see how many days remain and a CTA inviting them to request Deep instead.
- **Scan crashes mid-flight**: The scanning infrastructure fails to complete within the time budget. User sees a clear "scan interrupted" message, quota is refunded, and they can retry.
- **Scan completes with zero findings**: User sees an honest result ("no surface-level vulnerabilities detected") rather than an error, with guidance that this does not preclude deeper issues — and a CTA for Deep.
- **User closes the browser during DNS-poll**: When they return, the order is preserved at the same step. Verification continues to be checkable on demand.
- **User cancels a running scan**: If cancelled before significant cost is incurred, the free-Quick quota is returned; otherwise it is not.
- **Operator notification fails to send**: The Deep inquiry is still saved successfully; a background retry mechanism guarantees the operator is eventually notified, and the user does not see a failure.
- **Report rendering fails**: User sees findings in the dashboard; the report download shows a fallback message and is automatically regenerated in the background.
- **Anonymous Deep inquiry contains free-form sensitive data**: System sanitizes message payloads before forwarding to the operator channel (no plaintext password fragments leak from the scope description).

---

## Requirements *(mandatory)*

### Functional Requirements

**Account & Authentication**

- **FR-001**: System MUST allow new users to create an account using only an email address and a one-time sign-in link (no password).
- **FR-002**: System MUST prevent unauthenticated users from launching scans, viewing scan history, or accessing the dashboard.
- **FR-003**: System MUST allow the Deep inquiry form to be submitted by both signed-in users and unauthenticated visitors. For signed-in users the form pre-fills known fields.

**Quick scan wizard**

- **FR-004**: System MUST guide the user through exactly four wizard steps before a Quick scan can be launched, in this order: Attack Surface, Safety, Verify Domain, Launch.
- **FR-005**: System MUST allow the user, at the Attack Surface step, to enter one primary domain and review automatically discovered related hostnames (e.g., common subdomains) and accept or remove each.
- **FR-006**: System MUST allow the user, at the Attack Surface step, to specify global HTTP headers (e.g., a custom authorization token) to be sent with every probe request.
- **FR-007**: System MUST allow the user, at the Safety step, to choose a maximum request-rate from a set of presets (Safe, Default, Aggressive) with a numeric value clearly shown.
- **FR-008**: System MUST require ownership proof of the primary domain via a unique verification token published by the user as a DNS TXT record on that domain.
- **FR-009**: System MUST check for the verification token using public, independent DNS resolvers (not the system resolver) to mitigate spoofing.
- **FR-010**: System MUST continuously check for the verification token at most every five seconds for up to thirty minutes from request; if not found in that window, the order moves to a failed state and no scan-quota is consumed.
- **FR-011**: System MUST prevent the Launch step from being completed until ownership verification has succeeded.
- **FR-012**: System MUST display the exact verification value, target record name, and instructions in plain language and copy-to-clipboard form.

**Free Quick quota**

- **FR-013**: System MUST grant each signed-in user one free Quick scan per rolling seven-day window.
- **FR-014**: System MUST atomically prevent a user from launching a second free Quick scan inside the seven-day window (no race conditions on rapid double-click).
- **FR-015**: System MUST display, on the launch step and on the dashboard, how many days remain before the next free Quick is available — and a CTA inviting the user to request Deep meanwhile.
- **FR-016**: System MUST refund the free-Quick quota under each of the following conditions: ownership verification times out, the user cancels the scan before significant runtime is consumed, the scanning infrastructure fails to provision, or the scan times out without producing results.
- **FR-017**: System MUST NOT refund the free-Quick quota when the scan completes with zero findings — zero findings is a valid result.

**Scan execution and live view**

- **FR-018**: When a Quick scan is launched, the system MUST provision an isolated, ephemeral scanning environment per scan and tear it down at completion.
- **FR-019**: System MUST stream live progress events (provisioning, agent started, finding detected, phase changed, completed/failed) to the user's browser while the scan is in flight.
- **FR-020**: System MUST persist progress events such that the user can close and reopen the browser without losing the live view; on reconnect, they see the history plus continuing live events.
- **FR-021**: System MUST honor the user-selected request-rate budget when probing the target.
- **FR-022**: System MUST enforce a maximum scan duration (90 minutes for Quick). On expiration, the system marks the scan failed, tears down the environment, and refunds the quota.

**Findings and reporting**

- **FR-023**: System MUST persist each finding with at least: identifier, severity, title, target, CVSS score, CWE references, MITRE technique IDs (when applicable), description, reproduction steps, evidence references.
- **FR-024**: System MUST present a findings detail page where each finding can be inspected individually, including reproduction steps and any captured evidence artifacts.
- **FR-025**: System MUST generate a downloadable report (PDF) containing cover, executive summary, severity distribution, and the full content of every finding.
- **FR-026**: System MUST store report artifacts and evidence archives with a public retention window of at least 30 days from scan completion.
- **FR-027**: System MUST allow the user to re-generate a report on demand at any time the scan record exists (no new scan required).

**Email notification**

- **FR-028**: System MUST send the user an email when a scan completes, containing a link to the dashboard and the report PDF as attachment (or a link if the attachment cannot be produced).
- **FR-029**: System MUST retry email delivery on transient failures and never block scan completion or finding-display on email success.

**Deep inquiry**

- **FR-030**: System MUST provide a Deep-inquiry form on the Pricing page and (for signed-in users) in the dashboard, capturing at minimum: company name, contact full name, contact email, contact phone or messenger handle, target inventory, desired engagement date, budget range, scope description, and explicit data-processing consent.
- **FR-031**: System MUST reject Deep-inquiry submissions that lack any required field or the consent acceptance.
- **FR-032**: System MUST persist each Deep inquiry with a status lifecycle of `new → contacted → (converted | declined | dropped)` and the timestamp of operator notification.
- **FR-033**: System MUST notify the operator team in real time via a dedicated messenger channel within 60 seconds of a successful Deep-inquiry submission.
- **FR-034**: System MUST sanitize Deep-inquiry payloads (sent to the operator channel and stored in the database) so that obvious credentials patterns in the free-form scope text are masked.
- **FR-035**: System MUST retry operator notification on transient failures; the inquiry itself is saved successfully regardless of notification delivery state.
- **FR-036**: System MUST show the user a confirmation page after successful Deep-inquiry submission stating the team will respond within 24 hours.

**Dashboard and history**

- **FR-037**: System MUST display, on the user's dashboard, a list of their scans with current status, target, tier, and creation date.
- **FR-038**: System MUST allow users to cancel an in-flight scan.
- **FR-039**: System MUST allow users to navigate from any historical scan to its findings page and report download.

**Abuse and safety**

- **FR-040**: System MUST refuse to scan any domain for which ownership has not been verified for the requesting user, even if a different user has previously verified the same domain.
- **FR-041**: System MUST enforce rate limits on sign-in link requests, scan launches, and Deep inquiry submissions to prevent automated abuse.
- **FR-042**: System MUST log every state-changing operation (order creation, verification result, scan launch, scan completion, refund) in a tamper-evident audit trail.

**Data handling**

- **FR-043**: System MUST store Deep-inquiry personal data only with the user's explicit consent (recorded at form submission time) and MUST provide a process for the user to request deletion of their data.
- **FR-044**: System MUST automatically purge per-scan evidence archives 30 days after scan completion.
- **FR-045**: System MUST mark anonymous inquiries as such (no linked account) and avoid creating implicit accounts from them.

**Operator readiness for future payment activation**

- **FR-046**: System MUST support an operator-controlled toggle that, when activated, replaces the free-Quick CTA with a paid checkout flow and unlocks the Deep tier from "lead-gen only" to a future self-serve path. Until activated, the system behaves as in Free Quick + Deep-inquiry mode.

### Key Entities *(business-level, no implementation detail)*

- **User Account**: An authenticated identity tied to an email address. Owns scans, Deep inquiries, and quota.
- **Scan Order**: A user's intent to scan a specific primary domain at a specific tier, progressing through verification → launch → execution → completion states. Carries the full configuration (Attack Surface, Safety, ownership-verification token) and the resulting scan record.
- **Scan**: The actual scanning run associated with a Scan Order. Has status, start/completion timestamps, link to findings, and link to its report.
- **Finding**: A single discovered issue. Has severity, identifier, scoring (CVSS, CWE, MITRE), narrative description, reproduction steps, and evidence pointers.
- **Evidence Artifact**: Supporting data captured during a scan (e.g., HTTP responses, tool output). Linked to one or more findings.
- **Report**: The rendered, downloadable document summarizing one Scan's findings.
- **Deep Inquiry**: A request from a prospective customer for a Deep engagement, with contact info, target inventory, budget hint, desired schedule, and explicit consent. Tracked through a manual lifecycle to the operator.
- **Free Quick Quota**: A per-user counter ensuring at most one free Quick scan per rolling seven-day window. Refundable under specific failure conditions.
- **Audit Event**: An append-only, tamper-evident record of every state-changing operation across all entities.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

**Onboarding & first scan**

- **SC-001**: A first-time visitor who controls their target domain can go from landing page to seeing live scan progress in **under 15 minutes**, including signup, wizard completion, and DNS propagation wait, on at least 90% of attempts.
- **SC-002**: Of users who reach the wizard, at least **70% successfully complete ownership verification** within the 30-minute window on their first attempt.
- **SC-003**: At least **80% of Quick scans that pass ownership verification complete successfully** (i.e., produce findings or a confirmed no-findings result) within 20 minutes of launch.

**Reliability**

- **SC-004**: The 90th-percentile elapsed time from "Launch" click to "scan completed" notification is **at most 25 minutes** for Quick.
- **SC-005**: System uptime measured at the public sign-in endpoint is **at least 99% per calendar month**.
- **SC-006**: No more than **1% of completed Quick scans** fail to produce a downloadable report within 5 minutes of scan completion.

**Lead funnel**

- **SC-007**: Every Deep-inquiry submission reaches the operator's notification channel **within 60 seconds**, measured on at least 99% of submissions over any 30-day window.
- **SC-008**: At least **95% of Deep inquiries are responded to (status moves from `new` to `contacted`) within 24 hours** during operator working hours.

**Safety and integrity**

- **SC-009**: **Zero scans are launched against domains for which the requesting user has not passed ownership verification** (verified by audit log review monthly).
- **SC-010**: Every state-changing event for a Scan Order, Scan, Finding, or Deep Inquiry is recorded in the audit trail with an integrity chain that can be verified end-to-end with **no broken links** at any time.

**Cost & retention**

- **SC-011**: Free-Quick quota refunds (under defined failure conditions) are issued correctly in **at least 99% of cases**.
- **SC-012**: Report artifacts and evidence are available for download for **30 days post-completion** on at least 99.9% of completed scans.

**Abuse posture**

- **SC-013**: Free-Quick abuse via multi-account attempts can be detected and rate-limited; at most **3% of new accounts in a given week** are flagged as suspected duplicates after manual review.
- **SC-014**: No Deep inquiry leaks credentials or password-shaped strings to the operator notification channel in any 30-day window, measured by periodic sample audit.

---

## Assumptions

- **Decepticon engine is production-ready for blackbox scanning**: The scanning agent (already proven in the operator's local-smoke run of 2026-05-19 that produced 9 CVSS-scored findings against OWASP Juice Shop in 38 minutes) is treated as a stable dependency. Failures inside the engine are handled as time-outs at the orchestration layer.
- **Email infrastructure is available**: A transactional email provider can be wired in for sign-in links and scan-completion notifications, with retry semantics.
- **Operator availability for Deep follow-up is during Russian business hours**: The 24-hour Deep response SLA is intended for working days; weekend/holiday delays are acceptable for the MVP.
- **Russian residency of the operator entity**: The operator is registering a Russian sole-proprietor entity; this drives currency (RUB), language (Russian primary, English present but not primary), and applicable regulation (152-ФЗ for personal data).
- **DNS TXT verification is acceptable to target users**: SMB and corporate users are willing to add a TXT record to their own DNS for verification. Users without DNS access are out of scope for MVP.
- **Free Quick is sustainable as a lead-magnet**: The unit cost of a single Quick scan (compute + LLM tokens) is small enough relative to user lifetime value to justify offering it free in the introductory phase.
- **Paid payments are deferred but not abandoned**: The operator has a Russian sole-proprietor entity and is registering with a Russian payment gateway in parallel with this build. The MVP must operate end-to-end without paid checkout, but the data model and UI must accommodate a future toggle that turns on paid scans.
- **Deep engagement scope is negotiated off-platform in MVP**: The MVP does not attempt to automate Deep scans, billing for Deep, or contract management for Deep. The product surface for Deep is the inquiry form plus operator notification only.
- **Existing magic-link auth and audit-chain infrastructure are reused**: The backend already has working magic-link sign-in and an append-only signed audit log. These are foundations, not new work.
- **The legacy "expert mode" pages (multi-step Targets/Projects/Builder/Approval flow) are being decommissioned**: New users see only the wizard; no migration of prior data is in scope for MVP because there are no production users yet.

---
