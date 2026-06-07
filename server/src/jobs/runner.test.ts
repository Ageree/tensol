import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { type DB, createDb } from "../db/client.ts";
import { jobs as jobsTable } from "../db/schema.ts";
import { createRunner } from "./runner.ts";
import type { DispatchScanJob, Dispatcher } from "./types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

function migrationSql(): string {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((f) =>
			readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(
				/-->\s*statement-breakpoint/g,
				"",
			),
		)
		.join("\n");
}

function freshMemDb(): DB {
	const db = createDb(":memory:");
	(db.$client as Database).exec(migrationSql());
	return db;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	assertion: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (assertion()) return;
		await sleep(5);
	}
	expect(assertion()).toBe(true);
}

function makeDispatcher(processed: string[], delayMs = 0): Dispatcher {
	const dispatch = async (job: DispatchScanJob): Promise<void> => {
		if (delayMs > 0) await sleep(delayMs);
		processed.push(job.scan_id);
	};
	return {
		spawn_vps: async () => {},
		dispatch_scan: dispatch,
		watchdog_scan: async () => {},
		teardown_vps: async () => {},
	};
}

function rowsByStatus(
	db: DB,
	status: "pending" | "running" | "done" | "failed",
) {
	return db.select().from(jobsTable).where(eq(jobsTable.status, status)).all();
}

describe("createRunner", () => {
	const openDbs: DB[] = [];

	afterEach(() => {
		for (const db of openDbs.splice(0)) {
			(db.$client as Database).close();
		}
	});

	test("tick remains a single-job debugger step", async () => {
		const db = freshMemDb();
		openDbs.push(db);
		let ts = 1_700_000_000_000;
		const processed: string[] = [];
		const runner = createRunner({
			db,
			dispatcher: makeDispatcher(processed),
			now: () => ts++,
			watchdogIntervalMs: 0,
		});

		await runner.enqueue({
			type: "dispatch_scan",
			scan_id: "scan_1",
			vps_instance_id: "vps_1",
		});
		await runner.enqueue({
			type: "dispatch_scan",
			scan_id: "scan_2",
			vps_instance_id: "vps_2",
		});
		await runner.enqueue({
			type: "dispatch_scan",
			scan_id: "scan_3",
			vps_instance_id: "vps_3",
		});

		const claimed = await runner.tick();

		expect(claimed?.type).toBe("dispatch_scan");
		expect(processed).toEqual(["scan_1"]);
		expect(rowsByStatus(db, "done")).toHaveLength(1);
		expect(rowsByStatus(db, "pending")).toHaveLength(2);
	});

	test("start drains a burst without one poll interval per ready job", async () => {
		const db = freshMemDb();
		openDbs.push(db);
		let ts = 1_700_000_100_000;
		const processed: string[] = [];
		const runner = createRunner({
			db,
			dispatcher: makeDispatcher(processed, 10),
			now: () => ts++,
			pollIntervalMs: 50,
			maxJobsPerDrain: 3,
			watchdogIntervalMs: 0,
		});

		for (let i = 1; i <= 3; i += 1) {
			await runner.enqueue({
				type: "dispatch_scan",
				scan_id: `scan_${i}`,
				vps_instance_id: `vps_${i}`,
			});
		}

		runner.start();
		try {
			await waitFor(() => processed.length === 3, 130);
		} finally {
			await runner.stop();
		}

		expect(processed).toEqual(["scan_1", "scan_2", "scan_3"]);
		expect(rowsByStatus(db, "done")).toHaveLength(3);
	});
});
