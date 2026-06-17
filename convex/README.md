# Sthrip Convex Control Plane

This directory is the candidate Convex control plane for Sthrip. The current
production worker API is still the source of truth for heavy execution, while
Convex models reactive product state, settings, quotas, GitHub/review metadata,
audit events, and future orchestration.

## Operating Rules

- Read `convex/_generated/ai/guidelines.md` before editing Convex code.
- Keep public functions narrow and validator-backed. Use internal functions for
  private lifecycle steps.
- Derive authorization from `ctx.auth.getUserIdentity()` and the stored
  `tokenIdentifier`; never accept caller-supplied user IDs for ownership checks.
- Keep VM provisioning, scan execution, PDF rendering, object storage, and
  teardown in workers/adapters. Convex should coordinate state, not run heavy
  scanning work directly.
- Use bounded reads with indexes. Avoid query-builder `.filter()` and unbounded
  `.collect()` patterns.

## Current Lifecycle Notes

- `scanOrders.launch` debits either the weekly free Quick slot or a manual
  credit before scheduling `internal.gcloud.provisionScanVm`.
- `scanOrders.create` and `scanOrders.updateAttackSurface` normalize accepted
  hostnames for storage and reject non-public hostnames such as localhost,
  single-label names, IP literals, URLs, numeric final labels, and trailing-dot
  names before mutating order state.
- `ops.failScan` and `scanOrders.cancel` both route through
  `refundQuotaIfDebited`, so failed/cancelled terminal states refund the
  debited quota when no usable completed scan exists.
- `ops.completeScan` is the terminal success path. It does not refund quota,
  including zero-finding completions.
- `ops.completeScan` and `ops.failScan` both reserve scan-complete dedup keys
  only for callbacks that actually mutate scan state; duplicate or already
  terminal callbacks return 200-compatible statuses without new writes.
- `http.ts` accepts the production vps-agent V2 scan-complete payload:
  `scan_order_id`, terminal `status`, `completed_at`, and
  `X-Tensol-Signature: t=<sec>, v1=<hex>` signed with Convex `WEBHOOK_SECRET`
  (the fleet `TENSOL_WEBHOOK_SECRET`), then resolves the linked Convex `scan_id`.
- `billing.ts` creates OxaPay merchant invoices for PR Review and blackbox
  scan-credit products. `http.ts` accepts signed OxaPay callbacks at
  `/v1/webhooks/oxapay`; paid callbacks grant purchased entitlements exactly
  once.
- Real-GCP `gcloud.provisionScanVm` now stores the VM row, waits for a public IP,
  dispatches signed V2 `POST /scan` to the vps-agent, and fails plus tears down
  on provisioning/dispatch errors.
- `main.tsx` wraps the React app with `ConvexProviderWithClerk` when both Clerk
  and `VITE_CONVEX_URL` are configured. Settings falls back to REST/local state
  when Convex is unavailable.

## Verification

No standalone Convex script is established yet. Use:

```bash
bunx tsc -p convex/tsconfig.json --noEmit
```

For frontend consumers, also run the relevant `apps/site` type/build checks.
