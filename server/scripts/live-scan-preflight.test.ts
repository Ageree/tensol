import { describe, expect, test } from "bun:test";

import {
	secretSeparationChecks,
	storageEnvChecks,
} from "./live-scan-preflight.ts";

describe("storageEnvChecks", () => {
	test("fails when storage endpoint is missing even if bucket and keys are set", () => {
		const checks = storageEnvChecks({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			AWS_ACCESS_KEY_ID: "key",
			AWS_SECRET_ACCESS_KEY: "secret",
		});

		expect(checks.find((c) => c.name.includes("ENDPOINT"))).toMatchObject({
			ok: false,
		});
	});

	test("accepts explicit server storage aliases and defaults region detail to auto", () => {
		const checks = storageEnvChecks({
			TENSOL_EVIDENCE_BUCKET: "bucket",
			TENSOL_EVIDENCE_S3_ENDPOINT: "https://storage.example",
			TENSOL_EVIDENCE_S3_ACCESS_KEY_ID: "key",
			TENSOL_EVIDENCE_S3_SECRET_KEY: "secret",
		});

		expect(checks.every((c) => c.ok)).toBe(true);
		expect(checks.find((c) => c.name.includes("AWS_REGION"))?.detail).toBe(
			"auto",
		);
	});
});

describe("secretSeparationChecks", () => {
	test("fails when webhook and audit secrets are the same value", () => {
		const checks = secretSeparationChecks({
			TENSOL_WEBHOOK_SECRET: "same-secret",
			TENSOL_AUDIT_SIGNING_KEY: "same-secret",
		});

		expect(checks).toEqual([
			{
				name: "env.TENSOL_WEBHOOK_SECRET!=TENSOL_AUDIT_SIGNING_KEY",
				ok: false,
				detail:
					"must be distinct; audit key must never be reused as webhook secret",
			},
		]);
	});

	test("passes when webhook and audit secrets are distinct", () => {
		const checks = secretSeparationChecks({
			TENSOL_WEBHOOK_SECRET: "webhook-secret",
			TENSOL_AUDIT_SIGNING_KEY: "audit-secret",
		});

		expect(checks).toEqual([
			{
				name: "env.TENSOL_WEBHOOK_SECRET!=TENSOL_AUDIT_SIGNING_KEY",
				ok: true,
				detail: "distinct",
			},
		]);
	});

	test("does not duplicate missing-secret failures from the required-env checks", () => {
		const checks = secretSeparationChecks({});

		expect(checks).toEqual([
			{
				name: "env.TENSOL_WEBHOOK_SECRET!=TENSOL_AUDIT_SIGNING_KEY",
				ok: true,
				detail: "skipped until both secrets are set",
			},
		]);
	});
});
