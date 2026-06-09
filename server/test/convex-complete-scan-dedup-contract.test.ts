import { describe, expect, test } from "bun:test";

import { completeScan, failScan } from "../../convex/ops";

type FakeDbOptions = {
	readonly scanStatus:
		| "queued"
		| "running"
		| "completed"
		| "failed"
		| "cancelled";
	readonly orderStatus:
		| "draft"
		| "dns_pending"
		| "dns_verified"
		| "vm_provisioning"
		| "running"
		| "completed"
		| "failed"
		| "cancelled";
	readonly existingDedup?: boolean;
};

function createFakeCtx(options: FakeDbOptions) {
	const inserts: Array<{ table: string; value: unknown }> = [];
	const patches: Array<{ id: string; value: unknown }> = [];
	const scan = {
		_id: "scan_1",
		scan_order_id: "order_1",
		status: options.scanStatus,
	};
	const order = {
		_id: "order_1",
		primary_domain: "example.com",
		status: options.orderStatus,
	};

	return {
		ctx: {
			db: {
				get: async (id: string) => {
					if (id === scan._id) return scan;
					if (id === order._id) return order;
					return null;
				},
				query: (table: string) => ({
					withIndex: () => ({
						first: async () =>
							table === "webhookDedup" && options.existingDedup
								? { _id: "dedup_1" }
								: null,
					}),
				}),
				insert: async (table: string, value: unknown) => {
					inserts.push({ table, value });
					return `${table}_1`;
				},
				patch: async (id: string, value: unknown) => {
					patches.push({ id, value });
				},
			},
		},
		inserts,
		patches,
	};
}

function runCompleteScan(
	ctx: unknown,
	args: {
		readonly scanId: string;
		readonly dedupKey?: string;
	},
) {
	return (
		completeScan as unknown as {
			_handler: (ctx: unknown, args: unknown) => Promise<unknown>;
		}
	)._handler(ctx, {
		scanId: args.scanId,
		findings: [],
		dedupKey: args.dedupKey,
	});
}

function runFailScan(
	ctx: unknown,
	args: {
		readonly scanId: string;
		readonly dedupKey?: string;
	},
) {
	return (
		failScan as unknown as {
			_handler: (ctx: unknown, args: unknown) => Promise<unknown>;
		}
	)._handler(ctx, {
		scanId: args.scanId,
		reason: "agent_failed",
		dedupKey: args.dedupKey,
	});
}

describe("Convex scan-complete dedup contract", () => {
	test("does not reserve new dedup rows for terminal scans", async () => {
		const { ctx, inserts, patches } = createFakeCtx({
			scanStatus: "completed",
			orderStatus: "completed",
		});

		await expect(
			runCompleteScan(ctx, { scanId: "scan_1", dedupKey: "delivery-1" }),
		).resolves.toEqual({ status: "ignored_terminal" });

		expect(inserts.filter((insert) => insert.table === "webhookDedup")).toEqual(
			[],
		);
		expect(patches).toEqual([]);
	});

	test("still short-circuits existing duplicate deliveries before terminal state", async () => {
		const { ctx, inserts } = createFakeCtx({
			scanStatus: "completed",
			orderStatus: "completed",
			existingDedup: true,
		});

		await expect(
			runCompleteScan(ctx, { scanId: "scan_1", dedupKey: "delivery-1" }),
		).resolves.toEqual({ status: "duplicate" });

		expect(inserts).toEqual([]);
	});

	test("reserves failed callback dedup only when it mutates scan state", async () => {
		const { ctx, inserts, patches } = createFakeCtx({
			scanStatus: "running",
			orderStatus: "running",
		});

		await expect(
			runFailScan(ctx, { scanId: "scan_1", dedupKey: "delivery-failed-1" }),
		).resolves.toEqual({ status: "failed" });

		expect(inserts.map((insert) => insert.table)).toEqual([
			"webhookDedup",
			"scanEvents",
		]);
		expect(patches.map((patch) => patch.id)).toEqual(["scan_1", "order_1"]);
	});

	test("does not reserve failed callback dedup for terminal scans", async () => {
		const { ctx, inserts, patches } = createFakeCtx({
			scanStatus: "failed",
			orderStatus: "failed",
		});

		await expect(
			runFailScan(ctx, { scanId: "scan_1", dedupKey: "delivery-failed-1" }),
		).resolves.toEqual({ status: "ignored_terminal" });

		expect(inserts).toEqual([]);
		expect(patches).toEqual([]);
	});

	test("short-circuits duplicate failed callback deliveries", async () => {
		const { ctx, inserts, patches } = createFakeCtx({
			scanStatus: "failed",
			orderStatus: "failed",
			existingDedup: true,
		});

		await expect(
			runFailScan(ctx, { scanId: "scan_1", dedupKey: "delivery-failed-1" }),
		).resolves.toEqual({ status: "duplicate" });

		expect(inserts).toEqual([]);
		expect(patches).toEqual([]);
	});
});
