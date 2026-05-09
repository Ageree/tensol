import {
  ScanError,
  type ScanRequest,
  type ScanResult,
  type ScanRunner,
  type ScanRunnerDeps,
  scanRequestSchema,
} from './types.ts';

const DEFAULT_READY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export const createScanRunner = (deps: ScanRunnerDeps): ScanRunner => {
  const {
    hetzner,
    buildCloudInit,
    buildUserAgent,
    awaitCallback,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    callbackTimeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    logger,
  } = deps;

  return {
    async runScan(rawReq: ScanRequest): Promise<ScanResult> {
      const parseResult = scanRequestSchema.safeParse(rawReq);
      if (!parseResult.success) {
        throw new ScanError({ code: 'invalid_request', message: parseResult.error.message });
      }
      const req = parseResult.data;

      const startedAt = new Date(now()).toISOString();
      const userAgent = buildUserAgent({ scanId: req.scanId });
      const userData = buildCloudInit({
        scanId: req.scanId,
        tenantId: req.tenantId,
        targetUrl: req.targetUrl,
        callbackUrl: req.callbackUrl,
        callbackToken: req.callbackToken,
        decepticonImage: 'purpleailab/decepticon:latest',
        userAgent,
        maxRuntimeMs: req.maxRuntimeMs,
      });

      let serverId: number | undefined;
      let publicIpv4 = '';

      const createResult = await hetzner
        .createServer({
          name: `tensol-scan-${req.scanId}`,
          serverType: req.serverType,
          location: req.location,
          imageId: req.imageId,
          userData,
          labels: {
            scan_id: req.scanId,
            tenant_id: req.tenantId,
            managed_by: 'tensol',
          },
        })
        .catch((err: unknown) => {
          throw new ScanError({
            code: 'create_failed',
            message: 'Hetzner createServer failed',
            cause: err,
          });
        });

      serverId = createResult.server.id;
      publicIpv4 = createResult.server.publicNet.ipv4.ip;

      let outcome: ScanResult['outcome'] = 'completed';
      let logs = '';

      try {
        // Poll until server reaches 'running'
        const readyDeadline = now() + readyTimeoutMs;
        while (true) {
          const server = await hetzner.getServer(serverId);
          publicIpv4 = server.publicNet.ipv4.ip;
          if (server.status === 'running') break;

          if (now() >= readyDeadline) {
            throw new ScanError({
              code: 'ready_timeout',
              message: `Server ${serverId} did not reach 'running' within ${readyTimeoutMs}ms`,
            });
          }
          await sleep(pollIntervalMs);
        }

        // Await callback from VPS
        const abortController = new AbortController();
        const callbackTimer = setTimeout(() => abortController.abort(), callbackTimeoutMs);
        try {
          const callbackResult = await awaitCallback(req.scanId, abortController.signal);
          logs = callbackResult.logs;
        } catch (err: unknown) {
          if (abortController.signal.aborted) {
            throw new ScanError({
              code: 'callback_timeout',
              message: `Callback not received within ${callbackTimeoutMs}ms`,
              cause: err,
            });
          }
          throw err;
        } finally {
          clearTimeout(callbackTimer);
        }
      } catch (err: unknown) {
        // Always destroy on any post-create failure
        await hetzner.deleteServer(serverId).catch((destroyErr: unknown) => {
          logger?.error('destroyServer failed during cleanup', { serverId, cause: destroyErr });
        });
        throw err;
      }

      // Happy path: destroy after success
      const destroyResult = await hetzner.deleteServer(serverId).catch((destroyErr: unknown) => {
        logger?.error('destroyServer failed after successful scan', {
          serverId,
          cause: destroyErr,
        });
        return null;
      });

      if (destroyResult === null) {
        outcome = 'destroy_failed';
      }

      const finishedAt = new Date(now()).toISOString();

      return {
        scanId: req.scanId,
        hetznerServerId: serverId,
        publicIpv4,
        startedAt,
        finishedAt,
        outcome,
        logs,
      };
    },
  };
};
