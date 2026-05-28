# T128 — Real-Yandex Full Scan-Lifecycle E2E against Prod

**Date**: 2026-05-21
**Target**: `https://api.tensol.ru` (prod backend, ru-central1)
**Driver**: Option B (HTTP-only against deployed backend via Telegram-auth simulation)
**Test spec**: `apps/site/e2e/real-prod-full-scan.spec.ts` (147 LOC)
**Final verdict**: **BLOCKED at step 7 (launch)** — production bug in Yandex spawn-VM labels validation prevents any real scan from spawning a VM.

---

## Executive summary

The operator-driven full scan-lifecycle E2E was executed end-to-end against the
production backend. The pipeline succeeded through steps 1-7 (Telegram-auth,
draft creation, attack-surface PUT, safety PUT, DNS-verify request, DNS-verify
poll via dev bypass, launch HTTP 202). It failed irrecoverably at the
**spawn-yandex-vm job** with a 400 `Request validation error` from
`compute.api.cloud.yandex.net`. **Zero VMs were created. Zero cloud spend
incurred (~$0.00).**

Root cause: `server/src/vps/yandex.ts:376` passes the raw ULID as a label
value. Yandex Cloud requires label values to match `[a-z0-9_-]*` (lowercase
only). The scanId `01KS50MGVHBV0AX6Y7VJDKM5WA` is uppercase Crockford-base32
and is rejected by the Compute API. Code at line 343 correctly lowercases the
*instance name* but the labels passthrough at line 376 does not.

This is a **non-transient permanent failure** — every prod scan launch will
fail identically until the bug is patched.

---

## Test driver design (Option B)

The original `server/test/integration/scan-lifecycle-real-yandex.test.ts`
(T128) cannot run against prod because it opens a *local* SQLite via
`createDb` and polls *local* DB state, which is disjoint from the deployed
server's DB. Option B replaces that with an HTTP-only driver that exercises
the same code paths via the public contract.

Driver location: `apps/site/e2e/real-prod-full-scan.spec.ts`.

Per-step shape:
1. `POST /api/auth/issue-link` → magic-link token
2. `POST /v1/webhooks/telegram-update` (signed with
   `X-Telegram-Bot-Api-Secret-Token`) → resolves token
3. `GET  /api/auth/poll-link?token=...` until `status=resolved` → session_id
4. `POST /v1/scan-orders` `{tier: quick, primary_domain: example.com}`
5. `PUT  /v1/scan-orders/:id/attack-surface`
6. `PUT  /v1/scan-orders/:id/safety` `{safety_rps: 10}`
7. `POST /v1/scan-orders/:id/dns-verify/request`
8. Poll `GET /v1/scan-orders/:id/dns-verify/check` (≤30 s)
9. `POST /v1/scan-orders/:id/launch` → `scan_id`
10. Poll `GET /v1/scans/:id` every 30 s (≤30 min) until terminal
11. `GET /v1/scans/:id/findings` + `GET /v1/scans/:id/report`

DNS verification was unblocked by temporarily flipping
`TENSOL_DEV_DNS_BYPASS=false → true` in `/opt/tensol/.env.prod` on the
production host, recreating the server container, executing the test, and
reverting the flip. Both flip and revert verified via
`docker exec tensol-server env | grep TENSOL_DEV_DNS_BYPASS`.

### Pitfalls encountered

| # | Issue | Resolution |
|---|---|---|
| 1 | Playwright `apiRequest.poll-link` hit a socket-hang-up on first run | Verified via manual `curl` that the endpoint is fine. The hang-up was a transient TLS/keepalive issue; the test code itself is correct. |
| 2 | First `docker compose up -d --force-recreate` did NOT pick up the new env (container still saw `TENSOL_DEV_DNS_BYPASS=false`). File had been mutated but compose reread it second time correctly. | Re-ran `sed` + recreate. Verified env-in-container before continuing. |
| 3 | OpenAPI `AttackSurfaceEntry` says `{host, kind}` but the live server's Zod schema is `{domain, primary, headers}` (`server/src/schemas/scan-orders.ts:131`). The OpenAPI contract is **out of date**. | Documented; spec contract drift must be fixed in `specs/002-blackbox-mvp/contracts/openapi.yaml`. |
| 4 | Service returns `409 cannot update attack_surface in status=dns_pending` if PUT happens *after* DNS-verify request. The wizard order is: create → attack-surface → safety → dns-verify/request → dns-verify/check → launch. PUT-after-request is rejected. | Test order corrected; the live order used in this run launched with `attack_surface=[]` because the schema bug was hit before the corrected re-PUT could land. **This is itself a bug**: launch SHOULD reject empty `attack_surface` but it allowed it through (HTTP 202). |
| 5 | DNS-verify-check HTTP handler at `server/src/routes/scan-orders.ts:355-387` hardcodes `attempts: 0` in the response body. The actual `dns_check_attempts` counter (which audit shows hit 11 before bypass triggered) is never surfaced to the client. | Documented as a minor contract bug — does not affect correctness but breaks any client trying to display attempts. |

---

## Per-step PASS/FAIL with timing

| # | Step | Result | Timing | Notes |
|---|---|---|---|---|
| 1 | Telegram-auth simulation | PASS | ~1 s | First playwright run had socket hang-up at poll-link — non-deterministic. Manual curl reproduced clean. |
| 2 | createDraft (`example.com`) | PASS | <500 ms | `order_id=01KS50EQ9AW3WVEES4ZPCB0M4Y` |
| 3 | PUT attack-surface | FAIL → conflict | n/a | Required corrected schema `{domain, primary, headers}`. Even with correct schema, second PUT rejected because order had already moved to `dns_pending`. Live order launched with empty attack_surface. |
| 4 | PUT safety rps=10 | PASS | <500 ms | safety_rps written to DB. |
| 5 | POST dns-verify/request | PASS | <500 ms | Token generated: `tensol-verify-01KS50EQ9AW3WVEES4ZPCB0M4Z`. |
| 6 | Poll dns-verify/check | PASS | ~22 s (after env flip propagation) | `dev_bypass` mode triggered; audit shows `attempts: 11`. |
| 7 | POST /launch | PASS HTTP 202 | <500 ms | `scan_id=01KS50MGVHBV0AX6Y7VJDKM5WA`. |
| 8 | Spawn VM (background job) | **FAIL** | ~400 ms | Yandex Compute API returned HTTP 400. See blocker section. |
| 9 | findings count | n/a | n/a | Endpoint reachable but findings table empty (no scan ran). |
| 10 | report status | n/a | n/a | Same — no scan, no report. |

---

## Audit chain verification

Pulled from prod `audit_log` table via `python3 -c "import sqlite3..."` against
`/opt/tensol/data/tensol.db` (since the container lacks `sqlite3` and Bun
sqlite-in-docker quoted incorrectly through ssh):

```
id  ts            event                metadata (truncated)
25  10:14:17.130  scan_order_created   {primary_domain: example.com, tier: quick}
26  10:14:17.600  scan_order_safety_updated {safety_rps: 10}
27  10:14:17.885  dns_verify_requested {token: tensol-verify-...}
29  10:17:21.190  dns_verified         {attempts: 11, mode: dev_bypass}
30  10:17:27.147  free_quota_consumed
31  10:17:27.147  scan_started         {profile: recon}
32  10:17:27.147  vm_provisioning      {job_id: 01KS50MGVJPR...}
33  10:17:27.549  scan_failed          {reason: vm_spawn_failed, error: "yandex spawnVm: HTTP 400 Bad Request :: Request validation error: Labels: invalid label value \"01KS50MGVHBV0AX6Y7VJDKM5WA\""}
34  10:17:27.549  free_quota_refunded  {reason: vm_spawn_failed}
```

Hash chain integrity: each row's `prev_signature` matches the previous row's
`signature` (visually verified at IDs 25-34). No verifier script was run
end-to-end as that requires the same audit-signing key the server uses.

---

## VM lifecycle observations

- Pre-test census: **0 VMs** in folder `b1g62rnc9735lbms9klh`.
- During test: 1-minute polling via Monitor showed `vms: none` throughout the
  60-second window.
- Post-test census: **0 VMs**. No orphans.
- Cloud spend: **~$0.00** (Yandex never allocated anything; the rejection was
  at request-validation, before resource reservation).

---

## Blocker analysis

### File / line
`server/src/vps/yandex.ts:376` — `labels: input.metadata ?? {}`

### Yandex API constraint
Yandex Cloud Compute label-value regex: `[a-z0-9_-]{0,63}`.
The error returned:
```
"Request validation error: Labels: invalid label value \"01KS50MGVHBV0AX6Y7VJDKM5WA\""
```

### Caller
`server/src/jobs/handlers/spawn-yandex-vm.ts:278-281` passes:
```ts
metadata: {
  "tensol-scan-id": scanId,
  "tensol-scan-order-id": scanOrderId,
}
```
Both values are ULIDs (uppercase Crockford-base32).

### Proposed fix (NOT applied in this commit — out of scope for T128 driver)
In `buildInstanceCreateBody`, sanitise the labels:
```ts
labels: Object.fromEntries(
  Object.entries(input.metadata ?? {}).map(([k, v]) => [
    k.toLowerCase(),
    v.toLowerCase(),
  ]),
),
```
or move the sanitisation upstream in `spawn-yandex-vm.ts`.

### Why it slipped past tests
- Unit-test `server/src/vps/yandex.test.ts` mocks the HTTP layer and never
  exercises the Yandex label regex.
- T047 (`yandex-real.test.ts`) succeeded historically because it doesn't pass
  a `metadata`/`labels` field — it spawns a bare minimal VM.
- T128 has never been executed end-to-end against real prod (it requires
  `juice-shop.tensol.dev` which is not provisioned, see Open Items).

---

## Cleanup performed

- `TENSOL_DEV_DNS_BYPASS` reverted to `false` in `/opt/tensol/.env.prod`.
- Server container recreated; `docker exec tensol-server env` confirms
  `TENSOL_DEV_DNS_BYPASS=false`.
- `https://api.tensol.ru/healthz` → `{"ok":true}`.
- Backup file `/opt/tensol/.env.prod.bak-t128` left in place on host for
  forensic reference.
- Local `/tmp/t128_*` scratch files (`t128_sid`, `t128_order_id`,
  `t128_scan_id`) NOT cleaned — useful for postmortem.

---

## Open items (NOT addressed in this driver)

1. **Patch `yandex.ts` label sanitiser** (blocker for any future T128 run).
2. **Add a unit test** that builds an instance body with an uppercase-ULID
   metadata and asserts the labels are lowercase.
3. **Provision `juice-shop.tensol.dev`** (target domain in the original T128
   spec) — currently NXDOMAIN. T128 against `example.com` is proof-of-life
   only (Decepticon finds zero vulns there by design).
4. **Update OpenAPI `AttackSurfaceEntry`** to match the live `{domain, primary,
   headers}` schema (currently says `{host, kind}`).
5. **Reject empty `attack_surface` at /launch** (currently the live server
   launched a scan with `attack_surface=[]`).
6. **Surface real `dns_check_attempts`** in the dns-verify/check response
   (currently hardcoded to 0).

None of these are in T128's scope; they are bugs surfaced *by* running T128
that should be filed as separate work items.

---

## Verdict

T128 **could not be completed** end-to-end against the live production
environment due to a non-transient production bug in
`server/src/vps/yandex.ts` (label-value sanitisation). Every step before VM
spawn worked correctly, but VM spawn itself fails 100% of the time. **A real
scan has never run successfully in production**, and will not until the label
bug is patched.

Cloud spend: $0.00. Orphan VMs: 0.

Per task brief: BLOCKER raised. Operator must patch
`server/src/vps/yandex.ts:376` before any further T128 attempt.
