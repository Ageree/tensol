/**
 * T060 — watchdog_scan job handler.
 *
 * Liveness probe + 3-strike kill switch for running scans whose VPS
 * agent has gone silent. The handler is invoked on a periodic cadence
 * by an enqueuer (T061 — out of scope here); per invocation it does:
 *
 *   1. SELECT the scan. Missing or non-'running' → defensive no-op,
 *      no reschedule. This covers cancel races (status='cancelled'),
 *      finished scans (already terminal), and stale watchdog jobs
 *      enqueued for IDs that were purged.
 *
 *   2. Compute `stuck_for = now() - scan.started_at`. If the scan has
 *      been running for less than `stuckThresholdMs` (default 30min),
 *      skip the probe entirely and re-enqueue self in
 *      `rescheduleDelayMs` (default 5min). Counter is reset to 0
 *      because no failure occurred. NOTE: `started_at` is used as a
 *      proxy for "last heartbeat" — a scan in the 'running' state by
 *      definition has not received a terminal callback yet (the
 *      webhook receiver in T044 transitions to 'completed' / 'failed'
 *      on terminal events), so `now() - started_at` is the strongest
 *      "silent for X minutes" signal available from the operational
 *      schema. Per-callback liveness tracking (e.g. a
 *      `scans.last_callback_at` column) is a future refinement; the
 *      current proxy is conservative — it errs on the side of probing
 *      legitimately-long-running scans rather than missing dead ones.
 *
 *   3. SELECT the latest vps_instance for this scan. Missing → no-op
 *      (defensive, e.g. teardown raced the watchdog).
 *
 *   4. Probe `GET http://<vps.ipv4>:8080/status` via the injected
 *      `fetchImpl`, with a 10s AbortSignal timeout. The VPS agent
 *      binds plain TCP/8080 in cloud-init; dispatch_scan uses the
 *      same transport and relies on HMAC for authenticated commands.
 *      The watchdog probe is liveness-only and never sends secrets.
 *
 *     • 2xx OK              → counter resets to 0; reschedule
 *                              watchdog +5min; emit watchdog_action
 *                              audit (outcome=success, terminal=false).
 *     • non-2xx | network err → counter increments by 1.
 *         - If new counter < maxConsecutiveFailures (default 3):
 *           reschedule watchdog +5min with the incremented counter;
 *           emit watchdog_action (outcome=failure, terminal=false).
 *         - If new counter >= maxConsecutiveFailures: KILL SWITCH —
 *           UPDATE scans SET status='failed',
 *             failure_reason='agent_unresponsive', completed_at=now();
 *           enqueue teardown_vps(reason='agent_unresponsive');
 *           emit watchdog_action (outcome=failure, terminal=true);
 *           emit scan_failed (outcome=failure,
 *             metadata={reason:'agent_unresponsive', consecutive_failures:3}).
 *           No watchdog reschedule.
 *
 *   5. Audit emissions happen AFTER the operational transaction
 *      commits because `emitSignedAudit` opens its own BEGIN
 *      IMMEDIATE and bun:sqlite does not support nested transactions
 *      (same pattern as T040/T045). An audit-emit failure after a
 *      successful state transition leaves the system functional with
 *      a missing audit row; in practice emit failures are local
 *      SQLite errors that would also block the runner from marking
 *      the job done, so the operational invariant holds.
 *
 * Counter persistence model: `consecutive_failures` lives inside the
 * `WatchdogJob` payload — each handler invocation reads the incoming
 * counter, computes the new counter, and bakes it into the re-enqueued
 * job's payload. This avoids adding a schema column for transient
 * runtime state. Initial watchdog enqueues from T061 may omit the
 * field (treated as 0). On terminal kill switch no reschedule is
 * emitted, so the counter is naturally garbage-collected.
 *
 * SECURITY: probe URL is built from `vps_instances.ipv4` (provider-
 * supplied, validated at INSERT time in T040). sign_key is NEVER
 * included in the probe (the watchdog only checks aliveness, not
 * authenticity — the agent's terminal webhook callback is HMAC-
 * authenticated separately in T044) and is never written to audit
 * metadata here.
 */
import { eq } from "drizzle-orm";

import { emitSignedAudit } from "../../audit/emit.ts";
import type { DB } from "../../db/client.ts";
import { withTx } from "../../db/client.ts";
import { jobs, scans, vpsInstances } from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { now as defaultNow } from "../../lib/time.ts";
import type { Handler, TeardownVpsJob, WatchdogJob } from "../types.ts";

const DEFAULT_STUCK_THRESHOLD_MS = 30 * 60 * 1_000;
const DEFAULT_RESCHEDULE_DELAY_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const AGENT_PORT = 8080;

export interface WatchdogHandlerDeps {
	readonly db: DB;
	/** Injected fetch — production callers thread an agent-CA-aware
	 *  implementation; tests pass a pure mock. */
	readonly fetchImpl?: typeof fetch;
	/** Audit-log signing key. */
	readonly signingKey: string;
	readonly now?: () => number;
	/** Minimum scan age before a probe is issued. Default 30 min. */
	readonly stuckThresholdMs?: number;
	/** Delay until the next watchdog tick. Default 5 min. */
	readonly rescheduleDelayMs?: number;
	/** Number of consecutive failures that trip the kill switch.
	 *  Default 3 (i.e. the third failure marks the scan failed). */
	readonly maxConsecutiveFailures?: number;
	/** Per-probe abort timeout (ms). Default 10s. */
	readonly probeTimeoutMs?: number;
}

interface ProbeResult {
	readonly ok: boolean;
	readonly errorKind: "none" | "http" | "network";
	readonly status?: number;
	readonly errorMessage?: string;
}

async function probeAgent(
	fetchImpl: typeof fetch,
	url: string,
	timeoutMs: number,
): Promise<ProbeResult> {
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) {
			return { ok: true, errorKind: "none", status: res.status };
		}
		return { ok: false, errorKind: "http", status: res.status };
	} catch (err) {
		return {
			ok: false,
			errorKind: "network",
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}

function reschedule(
	db: DB,
	ts: number,
	payload: WatchdogJob,
	delayMs: number,
): void {
	const id = ulid(ts);
	db.insert(jobs)
		.values({
			id,
			type: "watchdog_scan",
			payloadJson: JSON.stringify(payload),
			status: "pending",
			scheduledAt: ts + delayMs,
			attempts: 0,
			lastError: null,
			createdAt: ts,
			updatedAt: ts,
		})
		.run();
}

/** Build a `watchdog_scan` Handler closing over the injected deps. */
export function createWatchdogHandler(
	deps: WatchdogHandlerDeps,
): Handler<WatchdogJob> {
	const {
		db,
		fetchImpl = fetch,
		signingKey,
		now = defaultNow,
		stuckThresholdMs = DEFAULT_STUCK_THRESHOLD_MS,
		rescheduleDelayMs = DEFAULT_RESCHEDULE_DELAY_MS,
		maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
		probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
	} = deps;

	return async function watchdogHandler(job: WatchdogJob): Promise<void> {
		// 1. Re-read the scan; bail out if missing or terminal.
		const scan = db.select().from(scans).where(eq(scans.id, job.scan_id)).get();
		if (!scan) return;
		if (scan.status !== "running") return;

		// 2. Under threshold? Skip probe, just keep the watchdog alive.
		const stuckFor = now() - scan.startedAt;
		if (stuckFor < stuckThresholdMs) {
			const ts = now();
			reschedule(
				db,
				ts,
				{
					type: "watchdog_scan",
					scan_id: scan.id,
					consecutive_failures: 0,
				},
				rescheduleDelayMs,
			);
			return;
		}

		// 3. Find the VPS to probe.
		const vps = db
			.select()
			.from(vpsInstances)
			.where(eq(vpsInstances.scanId, scan.id))
			.get();
		if (!vps || !vps.ipv4) return;

		// 4. Probe.
		const probeUrl = `http://${vps.ipv4}:${AGENT_PORT}/status`;
		const probe = await probeAgent(fetchImpl, probeUrl, probeTimeoutMs);

		// 5. Successful probe → reset counter + reschedule + success audit.
		if (probe.ok) {
			const ts = now();
			reschedule(
				db,
				ts,
				{
					type: "watchdog_scan",
					scan_id: scan.id,
					consecutive_failures: 0,
				},
				rescheduleDelayMs,
			);
			await emitSignedAudit(
				db,
				{
					event: "watchdog_action",
					outcome: "success",
					scan_id: scan.id,
					vps_instance_id: vps.id,
					metadata: {
						outcome: "probe_ok",
						terminal: false,
						consecutive_failures: 0,
						http_status: probe.status ?? 0,
					},
				},
				{ key: signingKey },
			);
			return;
		}

		// 6. Failed probe → increment counter; if at limit → kill switch.
		const incomingCount = job.consecutive_failures ?? 0;
		const newCount = incomingCount + 1;
		const terminal = newCount >= maxConsecutiveFailures;

		if (!terminal) {
			const ts = now();
			reschedule(
				db,
				ts,
				{
					type: "watchdog_scan",
					scan_id: scan.id,
					consecutive_failures: newCount,
				},
				rescheduleDelayMs,
			);
			await emitSignedAudit(
				db,
				{
					event: "watchdog_action",
					outcome: "failure",
					scan_id: scan.id,
					vps_instance_id: vps.id,
					metadata: {
						outcome: "probe_failure",
						terminal: false,
						consecutive_failures: newCount,
						error_kind: probe.errorKind,
						...(probe.status !== undefined && { http_status: probe.status }),
						...(probe.errorMessage && { error_message: probe.errorMessage }),
					},
				},
				{ key: signingKey },
			);
			return;
		}

		// 7. KILL SWITCH — mark scan failed + enqueue teardown.
		const killTs = now();
		const teardownPayload: TeardownVpsJob = {
			type: "teardown_vps",
			vps_instance_id: vps.id,
			reason: "agent_unresponsive",
		};

		await withTx(db, async (tx) => {
			tx.update(scans)
				.set({
					status: "failed",
					failureReason: "agent_unresponsive",
					completedAt: killTs,
				})
				.where(eq(scans.id, scan.id))
				.run();

			const teardownJobId = ulid(killTs);
			tx.insert(jobs)
				.values({
					id: teardownJobId,
					type: "teardown_vps",
					payloadJson: JSON.stringify(teardownPayload),
					status: "pending",
					scheduledAt: killTs,
					attempts: 0,
					lastError: null,
					createdAt: killTs,
					updatedAt: killTs,
				})
				.run();
		});

		// Terminal watchdog_action audit.
		await emitSignedAudit(
			db,
			{
				event: "watchdog_action",
				outcome: "failure",
				scan_id: scan.id,
				vps_instance_id: vps.id,
				metadata: {
					outcome: "probe_failure",
					terminal: true,
					consecutive_failures: newCount,
					error_kind: probe.errorKind,
					...(probe.status !== undefined && { http_status: probe.status }),
					...(probe.errorMessage && { error_message: probe.errorMessage }),
				},
			},
			{ key: signingKey },
		);

		// scan_failed audit for downstream consumers (T044 webhook +
		// reporting). Reason is the same string we wrote to
		// failure_reason so external observers can correlate.
		await emitSignedAudit(
			db,
			{
				event: "scan_failed",
				outcome: "failure",
				scan_id: scan.id,
				vps_instance_id: vps.id,
				metadata: {
					reason: "agent_unresponsive",
					consecutive_failures: newCount,
				},
			},
			{ key: signingKey },
		);
	};
}
