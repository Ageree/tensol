# ADR 0002 — Coordinator publishes `recon.browser` directly on assessment start

**Status:** Accepted (Sprint 9, 2026-04-29).

## Context

The product spec (Sprint 9, lines 414–444) describes the long-term browser-recon
plumbing as: Decepticon adapter emits a `recon_request` candidate → coordinator
translates that into a `recon.browser` job → browser-worker subscribes and runs
the scope-guarded crawl.

Sprint 8 shipped the FakeDecepticonAdapter without a `recon_request` stream —
the fixture-driven candidate stream emits only `xss_reflected` and similar
candidate types, not navigation requests. Wiring a recon_request channel
through the adapter would expand Sprint 9's scope and gate Sprint 10's
validator on adapter-side work.

## Decision

For Sprint 9 the coordinator publishes one `recon.browser` envelope per
declared assessment target **directly on the assessment.start allow path**,
in parallel with (and after) the FakeDecepticonAdapter session run. The
browser-worker subscribes to `recon.browser` and runs the scope-guarded
crawl per envelope.

The Sprint 7 placeholder envelope (`recon.browser.placeholder`) is kept for
one sprint of back-compat — Sprint 7 ITs subscribe on it and assert
behaviour. Sprint 10+ will retire it once those tests migrate.

## Consequences

- Browser-recon ships in Sprint 9 without taking on adapter API churn.
- Decepticon `recon_request` emission becomes a Sprint 11+ task (when the
  RealDecepticonAdapter Phase 2 lands).
- Two publishers run on every assessment.start allow path: placeholder
  (Sprint 7) + `recon.browser` (Sprint 9). Idempotency keys are distinct
  (`:targetId` vs `:browser:targetId`) so the two never collide.
- The browser-worker handler is wired through a `browserHandler` dep in
  `services/coordinator/src/index.ts` only when the API process explicitly
  passes it in — Sprint 7 ITs that don't subscribe to `recon.browser` see
  the envelopes pile up harmlessly in the queue.
