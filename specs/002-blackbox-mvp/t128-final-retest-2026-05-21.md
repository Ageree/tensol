# T128 — Final retest post-label-fix (2026-05-21)

**Verdict: PARTIAL SUCCESS — pipeline mechanics verified, NEW BLOCKER found at VM spawn (IAM 403 on resource-manager.folder).**

## Setup

- Server: live at `https://api.tensol.ru`, behind Cloudflare, on Yandex Cloud VM `5.42.106.25`.
- `sanitizeLabels()` patch (commit `eb1697a`) confirmed loaded: container image rebuilt 2026-05-21 09:52 UTC, 5/5 unit tests pass.
- Env flip: `TENSOL_DEV_DNS_BYPASS` true at 10:32 UTC, reverted to false at 14:08 UTC.
- Test driver: `apps/site/e2e/real-prod-full-scan.spec.ts` (HTTP client against prod API).

## Playwright spec — per-step result

| Step | Outcome | Timing | Notes |
|------|---------|--------|-------|
| 1. Telegram-auth webhook | PASS | 8.2s | Fire-and-forget required (see "blocker B" below); pollLink still resolved correctly via DB side-effect of `consumeLink` |
| 2. POST /v1/scan-orders (draft) | PASS | 0.1s | `orderId=01KS531Q16T1R2KW60P6896B39` |
| 3. PUT /attack-surface | PASS | 0.1s | Required schema fix in test (was `{host,kind}`, must be `{domain,primary,headers}`) |
| 4. PUT /safety rps=10 | PASS | 0.1s | |
| 5. POST /dns-verify/request | PASS | 0.1s | |
| 6. Poll /dns-verify/check | PASS | 6.2s | `verified=true` on first poll after 6s (≥ `DEV_BYPASS_MIN_ELAPSED_MS=5s`). Required raw `fetch` + `Connection: close` to dodge Cloudflare keepalive hang. |
| 7. POST /launch | PASS | 0.1s | `scan_id=01KS531XHK104025X1NG722NE0`, HTTP 202 |
| 8. Poll /v1/scans/:id | FAIL | 7.5min | scan went to `status=failed (vm_spawn_failed)` within 543ms of launch; test poll-loop kept polling, aborted by Cloudflare after ~7min idle |

## Audit chain progression

```
auth_login_requested        1779361168916
auth_login_succeeded        1779361169069   (T+0.15s — token resolved despite hung Telegram reply)
scan_order_created          1779361176614
scan_order_attack_surface_updated  1779361176787
scan_order_safety_updated   1779361176877
dns_verify_requested        1779361176966
dns_verified                1779361183170   (T+6.2s — dev bypass)
free_quota_consumed         1779361183281
scan_started                1779361183281
vm_provisioning(success)    1779361183281
scan_failed(vm_spawn_failed) 1779361183824  (T+543ms after vm_provisioning)
free_quota_refunded         1779361183824
```

Full chain integrity: 11 events for this run, all success/failure outcomes consistent with the state machine.

## NEW BLOCKER B — VM spawn IAM 403

From `jobs.last_error` payload of `retry_telegram_notification` job (operator_alert_vm_spawn_failed):

```
yandex spawnVm: HTTP 403 Forbidden ::
{
  "code": 7,
  "message": "Permission denied to resource-manager.folder b1g62rnc9735lbms9klh",
  "details": [{
    "@type": "type.googleapis.com/google.rpc.RequestInfo",
    "requestId": "c98c75b2-befa-4add-9400-5f55f381b071"
  }]
}
```

Distinct from the prior label-sanitisation 400 (now fixed). The IAM grants from the previous round (`compute.editor` + `vpc.externalAddresses.user` + `storage.editor` + `iam.user`) are NOT sufficient. Compute SDK additionally needs a **`resource-manager.viewer`** or `resource-manager.clouds.member` role on the folder, OR the SA must be added as a folder member at clouds scope.

**Operator action**:
```bash
yc resource-manager folder add-access-binding b1g62rnc9735lbms9klh \
  --role resource-manager.viewer \
  --subject serviceAccount:ajebdg35q6f107q3jl9k
```

(Or whichever sub-role compute API’s create-instance call actually requires — the message is generic. Trying `resource-manager.viewer` first is the principle-of-least-privilege guess.)

## Blocker A (workaround applied) — Yandex egress to api.telegram.org

While testing, observed:
- Container `netstat`: persistent `SYN_SENT 172.18.0.2:* → 149.154.166.110:443` (Telegram’s edge) — never establishes.
- `notifier.sendMessage(...)` inside `/v1/webhooks/telegram-update` hangs the request indefinitely; webhook never returns 200; Cloudflare upstreams a 524.
- This means **Yandex Cloud is rate-limiting / blackholing outbound TCP to api.telegram.org**.

Workaround in this run: fire-and-forget the webhook POST (3s timeout, swallow error). `consumeLink(...)` commits to DB before the hung `sendMessage` await, so `/api/auth/poll-link` returns `resolved` and the test proceeds.

**Recommended server-side fix** (separate task): wrap `notifier.sendMessage(...)` in a `Promise.race` with a 5s `setTimeout` OR detach via `queueMicrotask(() => sendMessage().catch(log))` so the webhook returns 200 immediately. Telegram-side delivery becomes best-effort. **NOTE:** this Yandex egress restriction also affects ALL production user signups going forward — bot replies will not be delivered to real users until either egress is unblocked or the send is moved to a job-runner background path.

## VM monitor log snapshot

37 ticks (~37 min) at 60s cadence, scan launched at tick #28 (11:00 UTC):

```
[10:32:49 tick 1] count=0
... (all 0)
[11:00:55 tick 29] count=0   ← scan_started at 11:00:13 UTC, no VM ever spawned
... (all 0 through tick 37)
[11:08:57 tick 37] count=0
```

Confirms: **zero VMs created in Yandex during this run.**

## Cleanup confirmation

- `grep TENSOL_DEV_DNS_BYPASS /opt/tensol/.env.prod` → `TENSOL_DEV_DNS_BYPASS=false` (reverted).
- Server health: `{"ok":true}` after restart.
- `compute.api.cloud.yandex.net/compute/v1/instances?folderId=b1g62rnc9735lbms9klh` → 0 instances.

## Cloud spend

$0 — no VM ever provisioned. IAM API calls are free.

## Findings count + report status

N/A — scan never executed (failed at VM spawn). No findings, no report row generated.

## Final verdict

- **Did the `sanitizeLabels()` fix work?** YES. No 400 Bad Request from invalid labels this run.
- **Did a REAL scan run through Decepticon successfully?** NO. Blocked one step later by IAM 403 on resource-manager.folder.
- **Pipeline mechanics validated up to and including `scan_started`/`vm_provisioning`.** Steps 1-7 of the test green.

Blockers remaining for true end-to-end:
1. **B1 (this finding)** — grant `resource-manager.viewer` (or appropriate folder-binding) to SA `ajebdg35q6f107q3jl9k`.
2. **B2** — outbound Telegram blocked from Yandex VM; webhook handler must defer reply to a job, not await inline.

## Test-spec fixes applied (in this session)

Committed alongside this evidence file:
- Username consistency between `issue-link` and Telegram webhook.
- DNS poll interval > `DEV_BYPASS_MIN_ELAPSED_MS=5s` (6s).
- attack-surface payload schema (`{domain, primary, headers}`).
- Webhook call fire-and-forget (B2 workaround).
- Raw `fetch` + `Connection: close` for dns-check polls (avoid Cloudflare keepalive hang).
- Poll cadence tuned to stay under the 10 req/min `/api/auth/*` rate-limit.
