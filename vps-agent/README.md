Sthrip vps-agent — runs on a per-scan ephemeral scanner VM and exposes the
minimal `/scan`, `/status`, and `/healthz` control surface.

Production dispatch uses the V2 callback path: the backend signs `/scan` with
the per-VM `TENSOL_SIGN_KEY`, then the agent runs Decepticon, uploads evidence,
and signs `POST /v1/webhooks/scan-complete` with `TENSOL_WEBHOOK_SECRET`.
If Decepticon, collection, bundling, or upload fails before evidence is ready,
the agent still sends `status="failed"` so the backend can fail the scan and
tear down the VM without waiting for the watchdog.
