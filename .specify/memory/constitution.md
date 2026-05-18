<!--
SYNC IMPACT REPORT
==================
Version change: (initial) → 1.0.0
Ratification date: 2026-05-18 (this constitution is the project's first ratified version)
Bump rationale: MAJOR initial — establishes 10 principles, two non-functional sections, and governance for Tensol Backend v2 clean-slate redesign.

Principles defined:
  I.    Decepticon Untouched
  II.   Three Load-Bearing Invariants (auth-proof, HMAC audit, egress isolation)
  III.  Single Binary, Single Package
  IV.   No Premature Abstraction
  V.    YAGNI Ruthlessly
  VI.   Test-First (NON-NEGOTIABLE)
  VII.  Files Small & Focused
  VIII. Immutable Data
  IX.   Validate at Boundaries
  X.    Audit Everything State-Changing

Sections defined:
  - Stack & Architecture Constraints
  - Development Workflow & Quality Gates

Templates requiring updates:
  ⚠ .specify/templates/plan-template.md — verify Constitution Check section references these 10 principles
  ⚠ .specify/templates/spec-template.md — verify scope sections reflect invariants
  ⚠ .specify/templates/tasks-template.md — verify task categories include audit/test-first/observability buckets
  ⚠ CLAUDE.md / AGENTS.md — runtime guidance; SPECKIT block already present

Follow-ups: none deferred. All placeholders replaced.
-->

# Tensol Backend v2 Constitution

## Core Principles

### I. Decepticon Untouched

The Decepticon engine at `external/decepticon/` is a vendored Apache-2.0 dependency. We
MUST NOT modify it. All Tensol-side behavior MUST live in `server/`. To track upstream
fixes, we `git pull` inside `external/decepticon/` — never patch in place. Any feature
that would require modifying Decepticon MUST first be filed as an upstream issue or
implemented as a wrapper in `server/`.

**Rationale:** Decepticon is the source of pentest capability; Tensol is the thin SaaS
shell. Forking the engine multiplies maintenance debt and forfeits the moat (validator
+ compliance + governance + distribution).

### II. Three Load-Bearing Invariants

Three invariants MUST hold for every scan that reaches Decepticon:

1. **Auth-proof**: a scan MUST NOT start unless the target has an `auth_proofs` row with
   `status='verified'`. Verification is by DNS TXT, file token, or meta tag — never
   self-assertion.
2. **HMAC audit log**: every state-changing operation MUST emit a row in `audit_log`
   via `emitSignedAudit()`. Rows form a hash chain; tampering MUST be detectable by
   chain verification.
3. **Egress isolation**: a scan MUST execute from an ephemeral VPS that is provisioned
   per-scan and destroyed at completion. No two scans share an outbound IP.

These three are NON-NEGOTIABLE. A pull request that removes or weakens any of them MUST
be rejected without further review.

**Rationale:** auth-proof keeps us out of court, audit gives us forensics + compliance
posture, egress isolation prevents one banned IP from killing the platform and prevents
WAF cross-contamination between tenants.

### III. Single Binary, Single Package

The backend is exactly one Bun package at `server/`. We MUST NOT introduce inner
workspace packages (`packages/*` is forbidden). The single binary serves HTTP and runs
the in-process job runner. The runtime stack is: TypeScript + Bun + Hono + Drizzle + SQLite.

**Rationale:** the previous architecture's ~12 packages and 3 runtimes were the bloat
this redesign exists to remove. Flat structure removes cross-package import dances,
dual tsconfigs, and ambiguous ownership.

### IV. No Premature Abstraction

- One use case → write the concrete function. No interface.
- Two use cases → extract a shared function. Still no interface.
- Three or more use cases that genuinely diverge → introduce an abstraction with a
  documented rationale.

We MUST NOT design for hypothetical future requirements. Three similar lines is better
than a premature factory.

**Rationale:** every abstraction we did not need was a future tax in indirection and
test-double sprawl.

### V. YAGNI Ruthlessly

The following are explicitly out of scope for v2 and MUST NOT be reintroduced without
amending this constitution:

- Action-cap / cost-cap as a Tensol-side layer (Decepticon env config covers this)
- Multi-tenant isolation beyond per-user data (one user = one organization)
- HA / horizontal scaling (single process, single SQLite file)
- buildOpplan / scope-engine / validator-worker / candidate_findings (deleted with v1)
- Real-time SSE / WebSocket scan progress to the browser (poll the scan row; webhook is server-to-server only)

**Rationale:** every removed feature was unproven demand or premature scale planning.

### VI. Test-First (NON-NEGOTIABLE)

Every new function or route MUST start with a failing test. Red → Green → Refactor.
Coverage floor is 80% across unit, integration, and E2E together. Tests live in
`server/src/**/*.test.ts` (unit) and `server/tests/integration/**/*.test.ts`. E2E lives
in `apps/site` (Playwright against a localhost backend).

Tests MUST hit real SQLite (in-memory mode) and a fake VPS provider — never mock the
database, never mock the audit signer.

**Rationale:** mocking the DB hid migration bugs that prod-failed in v1 (see prior
memory: "do not mock the database").

### VII. Files Small & Focused

Typical file is 200–400 lines. Hard cap is 800 lines. One file = one responsibility.
When a file approaches 600 lines, the next change MUST consider splitting first.

**Rationale:** smaller files load faster into agent context, are reviewed more
honestly, and keep blast radius small under change.

### VIII. Immutable Data

We MUST NOT mutate objects in place. Functions return new copies. Drizzle rows
returned from queries are treated as readonly; updates go through explicit `db.update()`
calls.

**Rationale:** immutable data prevents hidden side effects and makes parallel job
execution safe by construction.

### IX. Validate at Boundaries

Every HTTP route MUST have a Zod schema for its request body and URL params. Every
webhook payload MUST be Zod-validated before any other processing. Inside the server,
we trust internal function signatures and TypeScript types — no defensive runtime
validation for values that cannot be wrong.

**Rationale:** boundary validation is correctness; internal validation is noise.

### X. Audit Everything State-Changing

Every state-changing operation MUST emit a signed audit row before returning success.
Required events include but are not limited to: `user_logged_in`, `project_created`,
`target_created`, `auth_proof_issued`, `auth_proof_verified`, `scan_started`,
`vps_provisioned`, `decepticon_invoked`, `finding_emitted`, `scan_completed`,
`vps_destroyed`, `scan_failed`, `webhook_signature_invalid`.

All audit emissions MUST go through `emitSignedAudit(db, args)`. The canonical message
format is 13 pipe-delimited fields with alpha-sorted metadata JSON — bit-for-bit
identical to the EE-2 format so existing verifier tooling keeps working.

**Rationale:** the chain is only useful if it is complete. One missing event makes
forensics speculative.

## Stack & Architecture Constraints

- **Runtime**: Bun ≥ 1.1
- **HTTP framework**: Hono
- **ORM**: Drizzle
- **Database**: SQLite (file-backed in prod, in-memory in tests); upgrade path to PostgreSQL preserved by avoiding SQLite-only SQL constructs
- **Auth**: email + magic-link only; no passwords, no OAuth
- **Job runner**: in-process, SQLite-backed polling queue
- **VPS provisioning**: pluggable provider interface (`hetzner`, `do`, `yandex` impls
  permitted; first impl chosen during `/speckit-plan`)
- **Decepticon contract**: HTTP POST + final HMAC-signed webhook callback. No SSE, no
  SSH, no docker-exec from the API.
- **Repo layout** (forbidden / allowed):
  - Forbidden: `apps/api/`, `packages/*`, `services/*` (these were deleted with v1)
  - Allowed: `server/` (this backend), `apps/site/` (frontend, untouched),
    `external/decepticon/` (engine, untouched), `vps-agent/` (the ~50-line agent that
    runs on each ephemeral VPS), `docs/`, `.specify/`, `.harness/` (build tooling
    only)

## Development Workflow & Quality Gates

- **Spec-first**: every feature change ≥1 hour of work goes through
  `/speckit-specify → /speckit-plan → /speckit-tasks → /speckit-implement`. Inline edits
  for typos / log strings / single-line bugs are exempt.
- **TDD enforced**: per Principle VI; PR reviewer rejects PRs without a failing-test
  commit preceding the implementation commit.
- **Constitution check**: `/speckit-plan` MUST validate the plan against this file.
  Any deviation requires either a constitution amendment in the same PR or a documented
  justification in `complexity-tracking.md`.
- **Audit chain verification**: CI MUST run `verify-audit-chain` against the latest
  test DB; broken chains fail the build.
- **Backwards compatibility with v1**: NONE. v1 backend is deleted; no migration of v1
  data is supported. v1 git history is the rollback.

## Governance

- This constitution supersedes ad-hoc team conventions for `server/`.
- Amendments require a PR that updates this file, increments the version, and lists the
  affected principles in the Sync Impact Report.
- Versioning policy:
  - **MAJOR**: removing a principle, redefining a NON-NEGOTIABLE principle, or
    introducing a backwards-incompatible governance change.
  - **MINOR**: adding a new principle, materially expanding an existing principle, or
    adding a new section.
  - **PATCH**: wording clarifications, typo fixes, references, non-semantic refinements.
- Compliance review: every PR description MUST state which principles the change
  touches and how compliance is preserved. The reviewer MUST flag any unstated
  principle interaction.
- Runtime guidance lives in `CLAUDE.md`, `AGENTS.md`, and `docs/superpowers/specs/*`.
  Where guidance conflicts with this constitution, the constitution wins.

**Version**: 1.0.0 | **Ratified**: 2026-05-18 | **Last Amended**: 2026-05-18
