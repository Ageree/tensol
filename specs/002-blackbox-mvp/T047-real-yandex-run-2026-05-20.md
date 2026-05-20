# T047 — Real Yandex Cloud Integration Run

**Date:** 2026-05-20
**Task:** T047 (`server/src/vps/yandex-real.test.ts`, commit `e48a6da`)
**Operator:** post-loop step 4 (partial)
**Outcome:** **FAIL — IAM permission missing (HTTP 403)**
**VM created:** none
**Cloud spend:** ~$0.00 (no resources provisioned)
**Orphan VMs:** 0 (verified via `listInstances`)

---

## Environment

- **Bun:** 1.3.11
- **Test runner:** `bun test src/vps/yandex-real.test.ts`
- **Env source:** `server/.env.yandex` (sourced via `set -a; source .env.yandex; set +a`)
- **Override:** `TENSOL_TEST_REAL_YANDEX=1` (unlocks `describe.skipIf` guard)

### Env vars provided (names only — values redacted)

From `server/.env.yandex`:

- `YANDEX_SA_KEY_JSON` — service account JSON key (prod)
- `YANDEX_PROD_FOLDER_ID`
- `YANDEX_PROD_NETWORK_ID`
- `YANDEX_PROD_SUBNET_ID`
- `YANDEX_PROD_SUBNET_ZONE`
- `YANDEX_PROD_SSH_PUBLIC_KEY`
- `YANDEX_TEST_SA_KEY_JSON` (test variant — not used by provider default)
- `YANDEX_TEST_FOLDER_ID` (test variant)
- `YANDEX_TEST_NETWORK_ID`
- `YANDEX_TEST_SUBNET_ID`
- `YANDEX_TEST_SUBNET_ZONE`
- `YANDEX_TEST_SSH_PUBLIC_KEY`
- `TENSOL_EVIDENCE_BUCKET`
- `YANDEX_CLOUD_ID`

`createYandexCloudProvider()` defaults to `YANDEX_PROD_FOLDER_ID` (see `server/src/vps/yandex.ts:272-273`).

---

## Command

```bash
cd server
set -a
source .env.yandex
set +a
TENSOL_TEST_REAL_YANDEX=1 bun test src/vps/yandex-real.test.ts
```

## Full output (last 28 lines — entire log)

```
bun test v1.3.11 (af24e281)

src/vps/yandex-real.test.ts:
113 |         },
114 |         body: JSON.stringify(body),
115 |       });
116 |       if (!resp.ok) {
117 |         const detail = await readBodySafe(resp);
118 |         throw new Error(
                        ^
error: yandex spawnVm: HTTP 403 Forbidden :: {
 "code": 7,
 "message": "Permission denied to resource-manager.folder b1g62rnc9735lbms9klh",
 "details": [
  {
   "@type": "type.googleapis.com/google.rpc.RequestInfo",
   "requestId": "3c6f36b8-632e-45dd-a8ed-375fc2d3407f"
  }
 ]
}

      at spawnVm (/Users/saveliy/Documents/пентест ИИ/server/src/vps/yandex.ts:118:19)
      at async <anonymous> (/Users/saveliy/Documents/пентест ИИ/server/src/vps/yandex-real.test.ts:127:38)
✗ Yandex real provider (integration) > spawns minimal Ubuntu VM, observes provisioning → running, then tears down [454.18ms]

 0 pass
 1 fail
Ran 1 test across 1 file. [465.00ms]
```

---

## Diagnosis

The IAM token exchange (JWT-signed → IAM token) **succeeded** — otherwise the request would have failed at the 401 Unauthorized stage during JWT exchange. The 403 came from the **Compute API authorization layer**: the bearer token is valid, but the underlying service account **does not have create/edit permission on resource-manager folder `b1g62rnc9735lbms9klh`**.

Yandex `code: 7` = `PERMISSION_DENIED`. The folder ID matches `YANDEX_PROD_FOLDER_ID`, confirming the provider read the right env var.

### Read vs. write asymmetry

I separately ran `provider.listInstances(YANDEX_PROD_FOLDER_ID)` against the same folder with the same SA key:

```
{ "total": 0, "tensolVms": [] }
```

Either (a) the SA has `viewer` on the folder but not `compute.editor`/`compute.admin`, or (b) the folder genuinely has zero instances and the read succeeded by trivial luck (same 403 might apply to writes only). Either way, **no orphan VMs were created** by this test run.

---

## Cleanup verification

- T047 fails at `spawnVm()` before `spawnedInstanceId` is ever assigned (see `yandex-real.test.ts:127-128`).
- `afterAll` early-returns when `spawnedInstanceId === null`.
- Direct `listInstances` confirms no `tensol-*` VMs survived.
- `yc` CLI is not installed on this machine; the REST `listInstances` substitute returned an empty array.

**Zero orphan VMs. Zero cloud spend.**

---

## Required fix (operator action)

Grant the service account behind `YANDEX_SA_KEY_JSON` the **`compute.editor`** role (minimum) on folder `b1g62rnc9735lbms9klh`. From the Yandex Cloud console:

1. Resource Manager → folder `b1g62rnc9735lbms9klh` → Access bindings
2. Add service account → role `compute.editor` (or `compute.admin` for full lifecycle)
3. Also verify `vpc.user` on the same folder (needed to attach `YANDEX_PROD_SUBNET_ID`)
4. Re-run the test.

The two-tier strategy from `research.md §R11` still stands: T046 (offline mocks) is the unit-level contract; T047 (this file) is the live-API smoke. T046 passed in CI runs; T047 will pass once the IAM role is granted.

---

## What T128 (full E2E) still needs

T047 only tests the cloud-provider layer in isolation (spawn → poll → teardown a minimal Ubuntu VM). T128's full end-to-end scan flow also needs:

- **Public `TENSOL_WEBHOOK_BASE_URL`** so the vps-agent inside the VM can POST scan-progress webhooks back to the orchestrator (Cloudflare Tunnel, ngrok, or deployed orchestrator).
- **Published `vps-agent` Docker image** in a public-or-SA-readable registry (Container Registry on Yandex, GHCR public, or Docker Hub). Currently only built locally.
- **Published `decepticon` image** with the chosen LLM provider env (`DECEPTICON_MODEL_PROVIDER=auth` + `ANTHROPIC_API_KEY`/OAuth creds, or OpenRouter hijack from memory anchor `project_decepticon_llm_provider_matrix_2026-05-19.md`).
- **Resend API key** for the magic-link email delivery half of the scan-completed notification flow.
- **Telegram bot token + chat_id** for the operator-notification webhook (already provisioned for `@tensol_leadsbot`, but the Blackbox flow uses a separate channel).
- **IAM fix above** (compute.editor on prod folder).

T047 fixes (1 IAM grant); T128 needs (1) + (2) + (3) + (4) + (5) + IAM.

---

## Commit reference

Evidence committed as a single atomic change. See git log for SHA.

## Constitution alignment

- **I** — no edits under `external/decepticon/`. Only added a single evidence markdown.
- **VII** — this file is well under 800 LOC.
- No secret values logged (only env var names + the public folder ID returned in the Yandex 403 response, which is not sensitive on its own).
