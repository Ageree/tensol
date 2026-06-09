import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import {
	failureReason,
	normalizeWebhookFinding,
	optionalNumber,
	optionalRecord,
	optionalString,
	parseCompletedAt,
	parseSignature,
	parseTerminalStatus,
	webhookTarget,
} from "./lib/webhook";

const http = httpRouter();
const SIGNATURE_DRIFT_SECONDS = 5 * 60;
const COMPLETED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function hex(buffer: ArrayBuffer) {
	return [...new Uint8Array(buffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function hmacHex(secret: string, message: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
	);
}

async function hmacSha512Hex(secret: string, message: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
	);
}

async function digestHex(message: string) {
	return hex(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message)),
	);
}

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i += 1)
		out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

function oxapayField(body: Record<string, unknown>, key: string) {
	const direct = body[key];
	if (direct !== undefined) return direct;
	const data = body.data;
	if (data !== null && typeof data === "object" && !Array.isArray(data)) {
		return (data as Record<string, unknown>)[key];
	}
	return undefined;
}

function oxapayStatus(body: Record<string, unknown>) {
	const value = oxapayField(body, "status");
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "new" ||
		normalized === "waiting" ||
		normalized === "paying" ||
		normalized === "paid" ||
		normalized === "manual_accept" ||
		normalized === "underpaid" ||
		normalized === "expired" ||
		normalized === "refunding" ||
		normalized === "refunded"
	) {
		return normalized;
	}
	return null;
}

function oxapayTrackId(body: Record<string, unknown>) {
	const value = oxapayField(body, "track_id");
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

http.route({
	path: "/v1/webhooks/scan-complete",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		const rawBody = await req.text();
		const sig = parseSignature(req.headers.get("x-tensol-signature"));
		if (!sig) {
			return Response.json(
				{
					error: "webhook_invalid_signature",
					message: "missing or malformed X-Tensol-Signature header",
				},
				{ status: 401 },
			);
		}
		const nowSeconds = Math.floor(Date.now() / 1000);
		if (Math.abs(nowSeconds - sig.t) > SIGNATURE_DRIFT_SECONDS) {
			return Response.json(
				{
					error: "webhook_replay_too_old",
					message: "signature timestamp outside replay window",
				},
				{ status: 401 },
			);
		}

		const fleetSecret = (process.env.WEBHOOK_SECRET ?? "").trim();
		if (fleetSecret === "") {
			return Response.json(
				{
					error: "webhook_invalid_signature",
					message: "webhook signing secret is not configured",
				},
				{ status: 401 },
			);
		}
		const expected = await hmacHex(fleetSecret, `${sig.t}.${rawBody}`);
		if (!safeEqual(expected, sig.v1)) {
			return Response.json(
				{
					error: "webhook_invalid_signature",
					message: "Signature verification failed",
				},
				{ status: 401 },
			);
		}

		let body: Record<string, unknown>;
		try {
			const parsed = JSON.parse(rawBody) as unknown;
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				throw new Error("body must be a JSON object");
			}
			body = parsed as Record<string, unknown>;
		} catch {
			return Response.json(
				{ error: "webhook_body_invalid", message: "invalid JSON object" },
				{ status: 422 },
			);
		}

		const target = webhookTarget(body);
		if (!target) {
			return Response.json(
				{
					error: "webhook_body_invalid",
					message: "scan_order_id or scan_id required",
				},
				{ status: 422 },
			);
		}
		const status = parseTerminalStatus(body.status);
		if (!status) {
			return Response.json(
				{ error: "webhook_body_invalid", message: "invalid terminal status" },
				{ status: 422 },
			);
		}
		const completedAt = parseCompletedAt(body.completed_at);
		const nowMs = nowSeconds * 1000;
		if (
			completedAt === null ||
			completedAt < nowMs - COMPLETED_AT_MAX_AGE_MS ||
			completedAt > nowMs + SIGNATURE_DRIFT_SECONDS * 1_000
		) {
			return Response.json(
				{
					error: "webhook_body_invalid",
					message:
						"completed_at must be within the last 24h and not more than 5min in the future",
				},
				{ status: 422 },
			);
		}

		let resolved: { scanId: Id<"scans">; scanOrderId: Id<"scanOrders"> };
		try {
			resolved = await ctx.runQuery(internal.ops.getWebhookScanTarget, {
				...(target.scanId === undefined
					? {}
					: { scanId: target.scanId as Id<"scans"> }),
				...(target.scanOrderId === undefined
					? {}
					: { scanOrderId: target.scanOrderId as Id<"scanOrders"> }),
			});
		} catch {
			return Response.json(
				{ error: "webhook_body_invalid", message: "scan target not found" },
				{ status: 422 },
			);
		}

		const dedupKey =
			optionalString(body.delivery_id) ??
			optionalString(body.event_id) ??
			optionalString(body.id) ??
			`${resolved.scanOrderId}:${await digestHex(rawBody)}`;

		if (status === "failed") {
			const result = await ctx.runMutation(internal.ops.failScan, {
				scanId: resolved.scanId,
				reason: failureReason(body.failure_reason),
				dedupKey,
			});
			if (result.status === "failed") {
				await ctx.runAction(internal.gcloud.teardownScanVm, {
					scanId: resolved.scanId,
				});
			}
			return Response.json(
				{
					status: result.status,
					scan_id: resolved.scanId,
					scan_order_id: resolved.scanOrderId,
				},
				{ status: 200 },
			);
		}

		const usage = optionalRecord(body.usage);
		const rawFindings = Array.isArray(body.findings) ? body.findings : [];
		const result = await ctx.runMutation(internal.ops.completeScan, {
			scanId: resolved.scanId,
			findings: rawFindings.map((finding, i) =>
				normalizeWebhookFinding(finding, i),
			),
			usageTokens: optionalNumber(usage?.tokens),
			usageUsdCents: optionalNumber(usage?.usd_cents),
			dedupKey,
		});
		if (result.status === "completed") {
			await ctx.runAction(internal.gcloud.teardownScanVm, {
				scanId: resolved.scanId,
			});
		}
		return Response.json(
			{
				status: result.status,
				scan_id: resolved.scanId,
				scan_order_id: resolved.scanOrderId,
			},
			{ status: 200 },
		);
	}),
});

http.route({
	path: "/v1/webhooks/oxapay",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		const rawBody = await req.text();
		const received = (req.headers.get("hmac") ?? "").trim().toLowerCase();
		if (received === "") {
			return Response.json(
				{ error: "webhook_invalid_signature", message: "missing HMAC header" },
				{ status: 401 },
			);
		}

		const secret = (
			process.env.OXAPAY_WEBHOOK_SECRET ??
			process.env.OXAPAY_MERCHANT_API_KEY ??
			""
		).trim();
		if (secret === "") {
			return Response.json(
				{
					error: "webhook_invalid_signature",
					message: "OxaPay webhook secret is not configured",
				},
				{ status: 401 },
			);
		}

		const expected = await hmacSha512Hex(secret, rawBody);
		if (!safeEqual(expected, received)) {
			return Response.json(
				{ error: "webhook_invalid_signature", message: "HMAC verification failed" },
				{ status: 401 },
			);
		}

		let body: Record<string, unknown>;
		try {
			const parsed = JSON.parse(rawBody) as unknown;
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed)
			) {
				throw new Error("body must be a JSON object");
			}
			body = parsed as Record<string, unknown>;
		} catch {
			return Response.json(
				{ error: "webhook_body_invalid", message: "invalid JSON object" },
				{ status: 422 },
			);
		}

		const status = oxapayStatus(body);
		const trackId = oxapayTrackId(body);
		if (!status || !trackId) {
			return Response.json(
				{
					error: "webhook_body_invalid",
					message: "track_id and supported status are required",
				},
				{ status: 422 },
			);
		}

		try {
			await ctx.runMutation(internal.billing.fulfillOxaPayWebhook, {
				provider_track_id: trackId,
				status,
				raw_payload: body,
			});
		} catch {
			return Response.json(
				{ error: "webhook_body_invalid", message: "checkout session not found" },
				{ status: 422 },
			);
		}

		return new Response("ok", { status: 200 });
	}),
});

export default http;
