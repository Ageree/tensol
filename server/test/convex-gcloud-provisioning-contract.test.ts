import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
	buildAgentDispatchBody,
	buildStartupScript,
	signAgentDispatchBody,
} from "../../convex/lib/gcloudProvisioning";

describe("Convex GCP provisioning contract helpers", () => {
	test("startup script passes vps-agent V2 and evidence env", () => {
		const script = buildStartupScript({
			scanId: "scan-with-'quote",
			signKey: "per-vm-sign-key",
			env: {
				CONVEX_SITE_URL: "https://convex.example",
				WEBHOOK_SECRET: "fleet-webhook-secret",
				TENSOL_EVIDENCE_BUCKET: "sthrip-evidence",
				TENSOL_EVIDENCE_PREFIX: "scans/",
				VPS_AGENT_IMAGE: "registry.example/sthrip-agent:test",
			},
		});

		expect(script).toContain("docker run -d");
		expect(script).toContain("-e TENSOL_SCAN_ID='scan-with-'\"'\"'quote'");
		expect(script).toContain(
			"-e TENSOL_WEBHOOK_BACKEND_URL='https://convex.example'",
		);
		expect(script).toContain("-e TENSOL_WEBHOOK_SECRET='fleet-webhook-secret'");
		expect(script).toContain("-e TENSOL_SIGN_KEY='per-vm-sign-key'");
		expect(script).toContain("-e TENSOL_EVIDENCE_BUCKET='sthrip-evidence'");
		expect(script).toContain("-e TENSOL_EVIDENCE_PREFIX='scans/'");
		expect(script).not.toContain("-e AWS_ENDPOINT=");
		expect(script).not.toContain("-e AWS_ACCESS_KEY_ID=");
		expect(script).not.toContain("-e AWS_SECRET_ACCESS_KEY=");
		expect(script).not.toContain("-e AWS_REGION=");
		expect(script).toContain("registry.example/sthrip-agent:test");
	});

	test("dispatch body and signature match vps-agent /scan requirements", () => {
		const body = buildAgentDispatchBody({
			siteUrl: "https://convex.example/",
			evidenceBucket: "sthrip-evidence",
			scanId: "scan_123",
			material: {
				scanOrderId: "order_123",
				profile: "recon",
				primaryDomain: "example.com",
			},
		});
		const rawBody = JSON.stringify(body);
		const secret = "per-vm-sign-key";

		expect(body).toEqual({
			callback_version: "v2",
			profile: "recon",
			scan_id: "scan_123",
			scan_order_id: "order_123",
			target_url: "https://example.com",
			webhook_url: "https://convex.example/v1/webhooks/scan-complete",
			evidence_bucket: "sthrip-evidence",
		});
		expect(signAgentDispatchBody(secret, rawBody)).toBe(
			createHmac("sha256", secret).update(rawBody).digest("hex"),
		);
	});
});
