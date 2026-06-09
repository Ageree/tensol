/**
 * Live blackbox scan preflight.
 *
 * This is intentionally a read-only operator check. It catches the external
 * prerequisites that unit/E2E tests cannot prove: public callback reachability,
 * GCP credential presence, and whether a fresh scan VM can pull the worker
 * images that cloud-init asks Docker to run.
 */

import { existsSync, readFileSync } from "node:fs";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

const DECEPTICON_IMAGES = [
	"ghcr.io/purpleailab/decepticon-litellm:latest",
	"ghcr.io/purpleailab/decepticon-sandbox:latest",
	"ghcr.io/purpleailab/decepticon-langgraph:latest",
] as const;

const GHCR_MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
].join(",");

function check(name: string, ok: boolean, detail: string): Check {
	return { name, ok, detail };
}

function envFrom(source: NodeJS.ProcessEnv, name: string): string {
	return source[name]?.trim() ?? "";
}

function env(name: string): string {
	return envFrom(process.env, name);
}

function envAnyFrom(
	source: NodeJS.ProcessEnv,
	names: readonly string[],
): string {
	for (const name of names) {
		const value = envFrom(source, name);
		if (value) return value;
	}
	return "";
}

function envAny(names: readonly string[]): string {
	return envAnyFrom(process.env, names);
}

function isPublicHttpUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		return !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host);
	} catch {
		return false;
	}
}

function gcpCredentialCheck(): Check {
	const path = env("GOOGLE_APPLICATION_CREDENTIALS");
	if (!path) {
		return check(
			"gcp.credentials",
			true,
			"GOOGLE_APPLICATION_CREDENTIALS unset; GoogleAuth will use ADC if configured",
		);
	}
	if (!existsSync(path))
		return check("gcp.credentials", false, `file not found: ${path}`);
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as {
			client_email?: unknown;
			private_key?: unknown;
		};
		const ok =
			typeof json.client_email === "string" &&
			typeof json.private_key === "string";
		return check(
			"gcp.credentials",
			ok,
			ok
				? `service account ${json.client_email}`
				: "service account JSON lacks client_email/private_key",
		);
	} catch (err) {
		return check(
			"gcp.credentials",
			false,
			`invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function imageParts(
	image: string,
): { registry: string; repo: string; tag: string } | null {
	const [registry, ...rest] = image.split("/");
	const repoTag = rest.join("/");
	const idx = repoTag.lastIndexOf(":");
	if (!registry || !repoTag || idx <= 0) return null;
	return {
		registry,
		repo: repoTag.slice(0, idx),
		tag: repoTag.slice(idx + 1),
	};
}

async function ghcrToken(repo: string): Promise<string> {
	const url = new URL("https://ghcr.io/token");
	url.searchParams.set("service", "ghcr.io");
	url.searchParams.set("scope", `repository:${repo}:pull`);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`token HTTP ${res.status}`);
	}
	const body = (await res.json()) as { token?: unknown };
	if (typeof body.token !== "string" || !body.token) {
		throw new Error("token response lacked token");
	}
	return body.token;
}

async function checkGhcrImage(image: string): Promise<Check> {
	const parsed = imageParts(image);
	if (!parsed) {
		return check(
			`image.${image}`,
			false,
			"image must include registry/repo:tag",
		);
	}
	if (parsed.registry !== "ghcr.io") {
		return check(
			`image.${image}`,
			true,
			"non-GHCR image; pullability not checked by this preflight",
		);
	}
	try {
		const token = await ghcrToken(parsed.repo);
		const res = await fetch(
			`https://ghcr.io/v2/${parsed.repo}/manifests/${parsed.tag}`,
			{
				method: "HEAD",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: GHCR_MANIFEST_ACCEPT,
				},
			},
		);
		return check(
			`image.${image}`,
			res.ok,
			res.ok ? "manifest reachable" : `manifest HTTP ${res.status}`,
		);
	} catch (err) {
		return check(
			`image.${image}`,
			false,
			err instanceof Error ? err.message : String(err),
		);
	}
}

export function storageEnvChecks(
	source: NodeJS.ProcessEnv = process.env,
): Check[] {
	const bucket = envFrom(source, "TENSOL_EVIDENCE_BUCKET");
	const endpoint = envAnyFrom(source, [
		"AWS_ENDPOINT_URL",
		"TENSOL_EVIDENCE_S3_ENDPOINT",
	]);
	const accessKeyId = envAnyFrom(source, [
		"AWS_ACCESS_KEY_ID",
		"TENSOL_EVIDENCE_S3_ACCESS_KEY_ID",
	]);
	const secretAccessKey = envAnyFrom(source, [
		"AWS_SECRET_ACCESS_KEY",
		"TENSOL_EVIDENCE_S3_SECRET_KEY",
	]);
	const region =
		envAnyFrom(source, ["AWS_REGION", "TENSOL_EVIDENCE_S3_REGION"]) || "auto";

	return [
		check(
			"env.TENSOL_EVIDENCE_BUCKET",
			Boolean(bucket),
			bucket ? "set" : "missing; evidence/report storage disabled",
		),
		check(
			"env.AWS_ENDPOINT_URL|TENSOL_EVIDENCE_S3_ENDPOINT",
			Boolean(endpoint),
			endpoint ? endpoint : "missing; signed report downloads will be disabled",
		),
		check(
			"env.AWS_ACCESS_KEY_ID|TENSOL_EVIDENCE_S3_ACCESS_KEY_ID",
			Boolean(accessKeyId),
			accessKeyId ? "set" : "missing; evidence upload will fail",
		),
		check(
			"env.AWS_SECRET_ACCESS_KEY|TENSOL_EVIDENCE_S3_SECRET_KEY",
			Boolean(secretAccessKey),
			secretAccessKey ? "set" : "missing; evidence upload will fail",
		),
		check("env.AWS_REGION|TENSOL_EVIDENCE_S3_REGION", true, region),
	];
}

export function secretSeparationChecks(
	source: NodeJS.ProcessEnv = process.env,
): Check[] {
	const webhookSecret = envFrom(source, "TENSOL_WEBHOOK_SECRET");
	const auditSigningKey = envFrom(source, "TENSOL_AUDIT_SIGNING_KEY");
	const bothSet = Boolean(webhookSecret && auditSigningKey);
	const distinct = !bothSet || webhookSecret !== auditSigningKey;

	return [
		check(
			"env.TENSOL_WEBHOOK_SECRET!=TENSOL_AUDIT_SIGNING_KEY",
			distinct,
			!bothSet
				? "skipped until both secrets are set"
				: distinct
					? "distinct"
					: "must be distinct; audit key must never be reused as webhook secret",
		),
	];
}

async function main(): Promise<void> {
	const checks: Check[] = [];
	const webhookBaseUrl = env("TENSOL_WEBHOOK_BASE_URL");
	checks.push(
		check(
			"webhook.baseUrl",
			isPublicHttpUrl(webhookBaseUrl),
			webhookBaseUrl || "TENSOL_WEBHOOK_BASE_URL is not set",
		),
	);

	for (const name of [
		"GCP_PROJECT_ID",
		"GCP_ZONE",
		"TENSOL_WEBHOOK_SECRET",
		"TENSOL_AUDIT_SIGNING_KEY",
		"TENSOL_SESSION_COOKIE_SECRET",
	]) {
		const value = env(name);
		checks.push(
			check(`env.${name}`, Boolean(value), value ? "set" : "missing"),
		);
	}
	checks.push(...secretSeparationChecks());

	const openrouterKey = envAny([
		"TENSOL_OPENROUTER_API_KEY",
		"OPENROUTER_API_KEY",
	]);
	checks.push(
		check(
			"env.TENSOL_OPENROUTER_API_KEY|OPENROUTER_API_KEY",
			Boolean(openrouterKey),
			openrouterKey ? "set" : "missing",
		),
	);
	checks.push(
		check("env.GCP_NETWORK_NAME", true, env("GCP_NETWORK_NAME") || "default"),
	);
	checks.push(
		check("env.GCP_SUBNET_NAME", true, env("GCP_SUBNET_NAME") || "default"),
	);
	checks.push(...storageEnvChecks());

	checks.push(gcpCredentialCheck());

	const vpsAgentImage = env("TENSOL_VPS_AGENT_IMAGE");
	const decepticonImage = env("DECEPTICON_IMAGE");
	checks.push(
		check(
			"env.TENSOL_VPS_AGENT_IMAGE",
			Boolean(vpsAgentImage),
			vpsAgentImage || "missing",
		),
	);
	checks.push(
		check(
			"env.DECEPTICON_IMAGE",
			Boolean(decepticonImage),
			decepticonImage || "missing",
		),
	);

	const imageChecks = [
		...(vpsAgentImage ? [vpsAgentImage] : []),
		...(decepticonImage ? [decepticonImage] : []),
		...DECEPTICON_IMAGES,
	].map((image) => checkGhcrImage(image));
	checks.push(...(await Promise.all(imageChecks)));

	const width = Math.max(...checks.map((c) => c.name.length), 4);
	for (const c of checks) {
		const status = c.ok ? "PASS" : "FAIL";
		console.log(`${status} ${c.name.padEnd(width)} ${c.detail}`);
	}

	const failed = checks.filter((c) => !c.ok);
	if (failed.length > 0) {
		console.error(
			`\n${failed.length} live-scan preflight check(s) failed. Do not launch a real GCP scan until these are fixed.`,
		);
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	await main();
}
