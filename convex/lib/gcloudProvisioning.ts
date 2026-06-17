"use node";

import { createHmac } from "node:crypto";

export type DispatchProfile = "recon" | "standard" | "max";

export type DispatchMaterial = {
	scanOrderId: string;
	profile: DispatchProfile;
	primaryDomain: string;
};

export type ProvisioningEnv = {
	readonly backendUrl: string;
	readonly webhookSecret: string;
	readonly evidenceBucket: string;
	readonly evidencePrefix: string;
	readonly image: string;
};

export function firstNonEmpty(...values: Array<string | undefined>) {
	return (
		values.find((value) => value !== undefined && value.trim() !== "") ?? ""
	);
}

export function requiredEnvAny(
	env: NodeJS.ProcessEnv,
	...names: string[]
): string {
	const value = firstNonEmpty(...names.map((name) => env[name]));
	if (!value) throw new Error(`${names.join(" or ")} is required`);
	return value;
}

export function resolveProvisioningEnv(
	env: NodeJS.ProcessEnv = process.env,
): ProvisioningEnv {
	return {
		backendUrl: requiredEnvAny(
			env,
			"CONVEX_SITE_URL",
			"PUBLIC_CONVEX_SITE_URL",
		),
		webhookSecret: requiredEnvAny(env, "WEBHOOK_SECRET"),
		evidenceBucket: requiredEnvAny(
			env,
			"TENSOL_EVIDENCE_BUCKET",
			"EVIDENCE_BUCKET",
		),
		evidencePrefix:
			firstNonEmpty(env.TENSOL_EVIDENCE_PREFIX, env.EVIDENCE_PREFIX) ||
			"scans/",
		image: env.VPS_AGENT_IMAGE ?? "ghcr.io/tensol/vps-agent:latest",
	};
}

export function shQuote(value: string) {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function buildStartupScript(args: {
	readonly scanId: string;
	readonly signKey: string;
	readonly env?: NodeJS.ProcessEnv;
}) {
	const env = resolveProvisioningEnv(args.env);
	return `#!/usr/bin/env bash
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io
  systemctl enable --now docker
fi
docker rm -f sthrip-vps-agent || true
docker run -d --restart unless-stopped --name sthrip-vps-agent -p 8080:8080 \\
  -e TENSOL_SCAN_ID=${shQuote(args.scanId)} \\
  -e TENSOL_WEBHOOK_BACKEND_URL=${shQuote(env.backendUrl)} \\
  -e TENSOL_WEBHOOK_SECRET=${shQuote(env.webhookSecret)} \\
  -e TENSOL_SIGN_KEY=${shQuote(args.signKey)} \\
  -e TENSOL_EVIDENCE_BUCKET=${shQuote(env.evidenceBucket)} \\
  -e TENSOL_EVIDENCE_PREFIX=${shQuote(env.evidencePrefix)} \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  ${env.image}
`;
}

export function buildAgentDispatchBody(args: {
	readonly siteUrl: string;
	readonly evidenceBucket: string;
	readonly scanId: string;
	readonly material: DispatchMaterial;
}) {
	const siteUrl = args.siteUrl.replace(/\/+$/, "");
	return {
		callback_version: "v2" as const,
		profile: args.material.profile,
		scan_id: args.scanId,
		scan_order_id: args.material.scanOrderId,
		target_url: `https://${args.material.primaryDomain}`,
		webhook_url: `${siteUrl}/v1/webhooks/scan-complete`,
		evidence_bucket: args.evidenceBucket,
	};
}

export function signAgentDispatchBody(signKey: string, rawBody: string) {
	return createHmac("sha256", signKey).update(rawBody).digest("hex");
}
