# Purpose

`convex/` contains the Convex control-plane candidate for Sthrip data,
reactive functions, schema, auth mapping, quotas, scan/review state, GitHub,
settings, and operations.

# Ownership

- Own Convex schema, functions, HTTP actions, auth configuration, and helper
  libraries under `convex/`.
- Generated Convex files under `convex/_generated/` are framework outputs; do
  not manually edit them unless a tool-generated update explicitly requires it.

# Local Contracts

- Always read `convex/_generated/ai/guidelines.md` before editing Convex code.
- All Convex functions need argument validators.
- Use public `query`/`mutation`/`action` only for public API surfaces; use
  internal variants for private implementation functions.
- Failed or cancelled terminal scan states that had debited quota must call
  `refundQuotaIfDebited`; completed scans, including zero-finding completions,
  do not refund quota.
- OxaPay billing secrets must stay in Convex environment variables only:
  `OXAPAY_MERCHANT_API_KEY`, `OXAPAY_WEBHOOK_SECRET`,
  `OXAPAY_CALLBACK_URL`, and `STHRIP_BILLING_RETURN_URL`. Signed OxaPay
  webhooks are the only automatic path that grants paid billing entitlements.
- The Convex `POST /v1/webhooks/scan-complete` HTTP route must stay compatible
  with the production vps-agent V2 callback: body carries `scan_order_id`, and
  `X-Tensol-Signature` is signed with the fleet `TENSOL_WEBHOOK_SECRET` /
  Convex `WEBHOOK_SECRET`, not the per-VM `TENSOL_SIGN_KEY`.
- `ops.completeScan` and `ops.failScan` may short-circuit existing duplicate
  callback deliveries, but must not create new `webhookDedup` rows for callbacks
  ignored because the scan/order is already terminal.
- `scanOrders.create` and `scanOrders.updateAttackSurface` must store public
  DNS hostnames only; reject localhost, single-label hosts, IP literals, URLs,
  numeric final labels, and trailing-dot names before mutating order state.
- Real-GCP `internal.gcloud.provisionScanVm` must not mark scans as running
  without dispatching a signed V2 `/scan` request to the vps-agent. If dispatch
  or required storage/webhook env is unavailable, fail the scan and tear down
  any recorded VM.
- Keep high-churn operational data out of shared stable documents when modeling
  schema.

# Work Guidance

- Prefer schema and function patterns already present in this folder.
- Keep Convex as the control plane; heavy execution work such as VM
  provisioning, SAST tooling, PDF rendering, object storage, and cloud teardown
  should stay in dedicated workers/adapters unless a later design says
  otherwise.

# Verification

- No standalone Convex verification command is established in package scripts
  yet. Use project-level TypeScript/build checks or Convex CLI checks when the
  touched code requires them, and report any verification gap.

# Child DOX Index

No child Dox docs yet.
