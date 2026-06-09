import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type DB, createDb } from "../../db/client.ts";
import {
	jobs,
	scanOrders,
	scans,
	users,
	vpsInstances,
} from "../../db/schema.ts";
import { ulid } from "../../lib/ids.ts";
import { createWatchdogHandler } from "./watchdog.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "migrations");

function migrationSql(): string {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	return files
		.map((f) =>
			readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
				/-->\s*statement-breakpoint/g,
				"",
			),
		)
		.join("\n");
}

function applyMigrations(db: DB): void {
	(db.$client as Database).exec(migrationSql());
}

function seedRunningScanWithVm(db: DB, ts: number): { scanId: string } {
	const userId = ulid(ts);
	const orderId = ulid(ts + 1);
	const scanId = ulid(ts + 2);

	db.insert(users)
		.values({
			id: userId,
			email: "watchdog@x.test",
			createdAt: ts,
		})
		.run();

	db.insert(scanOrders)
		.values({
			id: orderId,
			userId,
			status: "running",
			tier: "quick",
			primaryDomain: "example.test",
			attackSurfaceJson: JSON.stringify([
				{ hostname: "example.test", included: true },
			]),
			safetyRps: 50,
			dnsVerifyToken: `tensol-verify-${"x".repeat(26)}`,
			dnsVerifiedAt: ts,
			dnsCheckAttempts: 1,
			vpsProvider: "gcp",
			vpsInstanceId: "watchdog-vm-1",
			vpsZone: "europe-west1-b",
			paymentKind: "free_quick",
			scanId,
			createdAt: ts,
			updatedAt: ts,
		})
		.run();

	db.insert(scans)
		.values({
			id: scanId,
			userId,
			scanOrderId: orderId,
			profile: "recon",
			status: "running",
			startedAt: ts - 31 * 60 * 1_000,
		})
		.run();

	db.insert(vpsInstances)
		.values({
			id: "watchdog-vm-1",
			scanId,
			provider: "gcp",
			providerServerId: "gcp-watchdog-vm-1",
			ipv4: "203.0.113.10",
			status: "alive",
			signKey: "agent-sign-key",
			createdAt: ts,
		})
		.run();

	return { scanId };
}

describe("createWatchdogHandler", () => {
	test("probes the vps-agent HTTP status endpoint on port 8080", async () => {
		const db = createDb(":memory:");
		applyMigrations(db);
		const ts = Date.now();
		const { scanId } = seedRunningScanWithVm(db, ts);
		const calls: string[] = [];

		const handler = createWatchdogHandler({
			db,
			signingKey: "test-key-watchdog-0123456789abcdef0123456789abcdef",
			now: () => ts,
			fetchImpl: (async (input, _init) => {
				calls.push(String(input));
				return new Response(JSON.stringify({ phase: "running" }), {
					status: 200,
				});
			}) as typeof fetch,
		});

		await handler(
			{
				type: "watchdog_scan",
				scan_id: scanId,
				consecutive_failures: 0,
			},
			{ jobId: "watchdog-job-1", attempts: 1 },
		);

		expect(calls).toEqual(["http://203.0.113.10:8080/status"]);
		expect(db.select().from(jobs).all()).toHaveLength(1);
	});
});
