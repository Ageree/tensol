# @cyberstrike/scan-runner

## 1. What this is

Ephemeral VPS spawner for Decepticon scans. Implements egress-isolation Strategy A (memory `project_tensol_egress_isolation_decision_2026-05-09.md`): one Hetzner droplet per scan, created on demand, destroyed after the callback is received. All I/O is injectable for testing; no real Hetzner calls are made in CI.

## 2. Wiring to a real Hetzner account

Set these environment variables in your deployment environment (never commit them):

| Variable | Description |
|---|---|
| `HETZNER_TOKEN` | Hetzner Cloud API token — read+write on Servers scope only |
| `HETZNER_DEFAULT_LOCATION` | Default datacenter (`fsn1`, `nbg1`, `hel1`, `ash`, `hil`) |
| `HETZNER_DEFAULT_SERVER_TYPE` | Default server type (`cpx11`, `cpx21`, `cpx31`) |

**How to obtain a token:**
1. Go to [Hetzner Cloud Console](https://console.hetzner.cloud/) → project → Security → API Tokens.
2. Create a token with **Read & Write** permission, scoped to the target project.
3. Store in your secrets manager (Vault, AWS Secrets Manager, etc.).

**Minimum IAM scope:** Servers — read + write. No SSH-key, network, firewall, or snapshot permissions required for basic operation.

**Revocation:** In Hetzner Cloud Console → Security → API Tokens → delete the token. Any in-flight scans that have already created a server will fail at the callback step; the server will be orphaned (picked up by the janitor cron — out of scope for this sprint).

## 3. Wiring to `packages/queue`

```typescript
// In services/coordinator — pseudocode
import { createScanRunner } from '@cyberstrike/scan-runner';
import { createHetznerClient } from '@cyberstrike/scan-runner';
import { buildCloudInit, buildUserAgent } from '@cyberstrike/scan-runner';
import type { Envelope } from '@cyberstrike/queue';

const hetzner = createHetznerClient({ token: process.env.HETZNER_TOKEN! });

const runner = createScanRunner({
  hetzner,
  buildCloudInit,
  buildUserAgent,
  awaitCallback: (scanId, signal) => awaitCallbackFromCoordinator(scanId, signal),
});

// Consumer of assessment.start envelopes from packages/queue
async function handleAssessmentStart(envelope: Envelope<'assessment.start'>) {
  const result = await runner.runScan({
    scanId: envelope.payload.scanId,
    tenantId: envelope.payload.tenantId,
    targetUrl: envelope.payload.targetUrl,
    serverType: process.env.HETZNER_DEFAULT_SERVER_TYPE as 'cpx21' ?? 'cpx21',
    location: process.env.HETZNER_DEFAULT_LOCATION as 'fsn1' ?? 'fsn1',
    imageId: Number(process.env.HETZNER_IMAGE_ID),
    callbackUrl: `${process.env.CALLBACK_BASE_URL}/callbacks/scans/${envelope.payload.scanId}`,
    callbackToken: generateCallbackToken(),
    maxRuntimeMs: 30 * 60 * 1000,
  });
  // Persist result to DB, emit assessment.complete envelope
}
```

See `packages/queue/src/types.ts` for `ENVELOPE_KINDS` definitions.

## 4. Wiring to `packages/decepticon-adapter`

`RealDecepticonAdapter` (in `packages/decepticon-adapter/src/real.ts`) today defaults to `localhost:2024` as the LangGraph endpoint. For VPS-spawn flow, reconfigure it to point at the spawned droplet's public IPv4:

```typescript
import { RealDecepticonAdapter } from '@cyberstrike/decepticon-adapter';

// After server reaches 'running' status, the scan-runner has the public IP.
// Pass it to the adapter when constructing the session client:
const adapter = new RealDecepticonAdapter({
  apiUrl: `http://${publicIpv4}:2024`,  // port 2024 is LangGraph Platform default
  // In production: TLS via Caddy sidecar on VPS — apiUrl = https://<ipv4>
});
```

The VPS cloud-init script provisions Decepticon via Docker; the LangGraph endpoint will be available at port 2024 once the container is healthy (polled by the runner's `pollUntilReady` → status `'running'`).

## 5. Operational posture

- **1 droplet per scan.** No warm pool in this sprint. Cold-start adds ~30–60s before Decepticon is ready.
- **Expected cost:** ~$0.01–0.02/scan at CPX21 (2 vCPU, 4GB RAM), 30-min max runtime, Hetzner Falkenstein pricing.
- **Failure modes:**
  - Hetzner outage → `createServer` fails → `ScanError{code:create_failed}` → no droplet leaked. The queue layer handles retry.
  - Decepticon crash on VPS → `awaitCallback` times out → `ScanError{code:callback_timeout}` → `destroyServer` called as cleanup.
  - `destroyServer` fails → `outcome:'destroy_failed'` returned (non-throwing). A janitor cron (future sprint) reaps servers with label `managed_by=tensol` older than 2h.
- **Secrets never logged.** `callbackToken`, `HETZNER_TOKEN`, and `root_password` are redacted by convention in all log calls.

## 6. Open questions

See `docs/research/decepticon-dossier.md` §Open Questions for the 5 unresolved architectural decisions (embedding strategy, version pin policy, scan-state ownership, LLM provider, cold-start UX).
