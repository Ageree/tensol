import { describe, expect, test } from "bun:test";

import {
	secretSeparationChecks,
	storageEnvChecks,
} from "./live-scan-preflight.ts";

describe("storageEnvChecks", () => {
	test("fails when bucket is missing", () => {
		const checks = storageEnvChecks({});

		expect(checks.find((c) => c.name.includes("BUCKET"))).toMatchObject({
			ok: false,
		});
	});

	test("accepts a GCS evidence bucket without S3 keys", () => {
		const checks = storageEnvChecks({
			TENSOL_EVIDENCE_BUCKET: "bucket",
		});

		expect(checks.every((c) => c.ok)).toBe(true);
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
