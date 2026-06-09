/**
 * Failed free-Quick scans must refund the user's visible quota slot.
 *
 * This guards the V2 callback path where vps-agent reports a terminal
 * `status=failed`: the backend refunds the debited free quota, and the
 * dashboard/settings screens must treat the failed order as non-consuming.
 */
import {
	type APIRequestContext,
	expect,
	request as pwRequest,
	test,
} from "@playwright/test";
import { attachConsoleAssertions } from "./helpers/console.ts";
import {
	BACKEND_BASE_URL,
	E2E_WEBHOOK_SECRET,
	FRONTEND_BASE_URL,
	attachSessionCookie,
	createDnsVerifiedOrder,
	seedSession,
	signWebhookBody,
} from "./helpers/scan-wizard-helpers.ts";

interface LaunchResult {
	readonly scan_id: string;
	readonly status: string;
}

interface FailedWebhookResult {
	readonly status: string;
	readonly scan_order_id: string;
	readonly findings_ingested: number;
}

async function launchOrder(
	backend: APIRequestContext,
	sessionId: string,
	orderId: string,
): Promise<LaunchResult> {
	const res = await backend.post(`/v1/scan-orders/${orderId}/launch`, {
		headers: { cookie: `tensol_session=${sessionId}` },
		data: {},
	});
	expect(res.status()).toBe(202);
	return (await res.json()) as LaunchResult;
}

async function cancelOrder(
	backend: APIRequestContext,
	sessionId: string,
	orderId: string,
): Promise<{ status: string }> {
	const res = await backend.delete(`/v1/scan-orders/${orderId}`, {
		headers: { cookie: `tensol_session=${sessionId}` },
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as { status: string };
}

async function postFailedScanComplete(
	backend: APIRequestContext,
	orderId: string,
): Promise<FailedWebhookResult> {
	const body = JSON.stringify({
		scan_order_id: orderId,
		status: "failed",
		failure_reason: "e2e_failed_free_quota_refund",
		completed_at: Date.now(),
		duration_seconds: 13,
		findings: [],
	});
	const nowSec = Math.floor(Date.now() / 1000);
	const signature = signWebhookBody(E2E_WEBHOOK_SECRET, body, nowSec);

	const res = await backend.post("/v1/webhooks/scan-complete", {
		headers: {
			"content-type": "application/json",
			"x-tensol-signature": signature,
		},
		data: body,
	});
	expect(res.status()).toBe(200);
	return (await res.json()) as FailedWebhookResult;
}

test.describe("failed free-Quick quota refund", () => {
	test.setTimeout(60_000);

	test("dashboard and settings show quota available after failed callback refund", async ({
		page,
		context,
	}) => {
		const console$ = attachConsoleAssertions(page);
		const backend = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
		const failedDomain = `failed-refund-${Date.now()}.example.test`;

		try {
			const seed = await seedSession(
				backend,
				`e2e+failed-refund+${Date.now()}@example.test`,
			);
			await attachSessionCookie(context, seed.session_id, FRONTEND_BASE_URL);

			const failedOrder = await createDnsVerifiedOrder(
				backend,
				seed.user_id,
				failedDomain,
				25,
			);
			const launch = await launchOrder(
				backend,
				seed.session_id,
				failedOrder.order_id,
			);
			expect(launch.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

			const failed = await postFailedScanComplete(
				backend,
				failedOrder.order_id,
			);
			expect(failed).toMatchObject({
				status: "failed",
				scan_order_id: failedOrder.order_id,
				findings_ingested: 0,
			});

			// Backend proof: a second free-Quick launch must succeed after the
			// failed callback refund. Without the refund this POST returns 429.
			const quotaProbe = await createDnsVerifiedOrder(
				backend,
				seed.user_id,
				`quota-probe-${Date.now()}.example.test`,
				25,
			);
			const probeLaunch = await launchOrder(
				backend,
				seed.session_id,
				quotaProbe.order_id,
			);
			expect(probeLaunch.scan_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
			await expect(
				cancelOrder(backend, seed.session_id, quotaProbe.order_id),
			).resolves.toMatchObject({ status: "cancelled" });

			await page.goto("/dashboard");
			await page.waitForLoadState("networkidle");

			const blackboxMetric = page
				.locator(".metric-card")
				.filter({ hasText: "Blackbox scans" });
			await expect(blackboxMetric).toContainText("Included");

			const failedRow = page.locator("tr").filter({ hasText: failedDomain });
			await expect(failedRow).toBeVisible();
			await expect(failedRow).toContainText("failed");
			await expect(failedRow).toContainText("Retry");

			await page.goto("/settings");
			await page.waitForLoadState("networkidle");
			await expect(page.getByTestId("settings-quota")).toContainText(
				/available/i,
			);

			console$.assertClean();
		} finally {
			await backend.dispose();
		}
	});
});
