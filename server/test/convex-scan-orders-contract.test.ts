import { describe, expect, test } from "bun:test";

import {
	create as createScanOrder,
	updateAttackSurface,
} from "../../convex/scanOrders";

type AttackSurfaceEntry = {
	readonly domain: string;
	readonly primary: boolean;
	readonly headers: Array<{ readonly k: string; readonly v: string }>;
};

type ScanOrderStatus =
	| "draft"
	| "dns_pending"
	| "dns_verified"
	| "vm_provisioning"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

function baseUser() {
	return {
		_id: "user_1",
		tokenIdentifier: "clerk|user_1",
		subject: "user_1",
		issuer: "https://clerk.example",
		email: "user@example.com",
		created_at: 1,
		updated_at: 1,
		free_quick_consumed_count: 0,
	};
}

function baseOrder(
	overrides: Partial<{
		status: ScanOrderStatus;
		primary_domain: string;
		attack_surface: AttackSurfaceEntry[];
	}> = {},
) {
	return {
		_id: "order_1",
		userId: "user_1",
		status: overrides.status ?? "draft",
		tier: "quick",
		primary_domain: overrides.primary_domain ?? "example.com",
		attack_surface: overrides.attack_surface ?? [],
		safety_rps: 50,
		dns_verify_token: "sthrip-examplecom-token",
		dns_check_attempts: 0,
		vps_provider: "gcp",
		payment_kind: "free_quick",
		created_at: 1,
		updated_at: 1,
	};
}

function createFakeCtx(
	options: {
		readonly order?: ReturnType<typeof baseOrder>;
	} = {},
) {
	const user = baseUser();
	let order = options.order ?? null;
	const inserts: Array<{ table: string; value: Record<string, unknown> }> = [];
	const patches: Array<{ id: string; value: Record<string, unknown> }> = [];

	return {
		ctx: {
			auth: {
				getUserIdentity: async () => ({
					tokenIdentifier: user.tokenIdentifier,
					subject: user.subject,
					issuer: user.issuer,
					email: user.email,
				}),
			},
			db: {
				query: (table: string) => ({
					withIndex: () => ({
						unique: async () => (table === "users" ? user : null),
					}),
				}),
				insert: async (table: string, value: Record<string, unknown>) => {
					inserts.push({ table, value });
					if (table === "scanOrders") {
						order = baseOrder(value);
						return order._id;
					}
					return `${table}_1`;
				},
				get: async (id: string) => {
					if (id === user._id) return user;
					if (id === order?._id) return order;
					return null;
				},
				patch: async (id: string, value: Record<string, unknown>) => {
					patches.push({ id, value });
					if (id === order?._id) {
						order = { ...order, ...value };
					}
				},
			},
		},
		inserts,
		patches,
		getOrder: () => order,
	};
}

function runCreate(ctx: unknown, primaryDomain: string) {
	return (
		createScanOrder as unknown as {
			_handler: (ctx: unknown, args: unknown) => Promise<unknown>;
		}
	)._handler(ctx, {
		tier: "quick",
		primary_domain: primaryDomain,
	});
}

function runUpdateAttackSurface(
	ctx: unknown,
	attackSurface: AttackSurfaceEntry[],
) {
	return (
		updateAttackSurface as unknown as {
			_handler: (ctx: unknown, args: unknown) => Promise<unknown>;
		}
	)._handler(ctx, {
		id: "order_1",
		attack_surface: attackSurface,
	});
}

describe("Convex scanOrders contract", () => {
	test("normalizes primary_domain before storage, DNS token, and audit metadata", async () => {
		const { ctx, inserts } = createFakeCtx();

		await expect(runCreate(ctx, "  Example.COM  ")).resolves.toMatchObject({
			primary_domain: "example.com",
		});

		const orderInsert = inserts.find((insert) => insert.table === "scanOrders");
		const auditInsert = inserts.find((insert) => insert.table === "auditEvents");
		expect(orderInsert?.value.primary_domain).toBe("example.com");
		expect(String(orderInsert?.value.dns_verify_token)).toStartWith(
			"sthrip-examplecom-",
		);
		expect(auditInsert?.value.metadata).toEqual({
			primary_domain: "example.com",
			tier: "quick",
		});
	});

	test.each([
		"localhost",
		"127.0.0.1",
		"https://example.com",
		"example.123",
		"example.com.",
	])("rejects non-public primary_domain %s", async (primaryDomain) => {
		const { ctx, inserts } = createFakeCtx();

		await expect(runCreate(ctx, primaryDomain)).rejects.toMatchObject({
			data: {
				error: "validation_error",
				message: "primary_domain must be a public lowercase DNS hostname",
			},
		});
		expect(inserts).toEqual([]);
	});

	test("normalizes attack_surface domains before patching the draft order", async () => {
		const { ctx, patches } = createFakeCtx({ order: baseOrder() });

		await expect(
			runUpdateAttackSurface(ctx, [
				{ domain: "  Example.COM  ", primary: true, headers: [] },
				{ domain: "Api.Example.COM", primary: false, headers: [] },
			]),
		).resolves.toMatchObject({
			attack_surface: [
				{ domain: "example.com", primary: true, headers: [] },
				{ domain: "api.example.com", primary: false, headers: [] },
			],
		});

		expect(patches[0]?.value.attack_surface).toEqual([
			{ domain: "example.com", primary: true, headers: [] },
			{ domain: "api.example.com", primary: false, headers: [] },
		]);
	});

	test.each(["localhost", "127.0.0.1", "example.123"])(
		"rejects non-public attack_surface domain %s",
		async (domain) => {
			const { ctx, patches } = createFakeCtx({ order: baseOrder() });

			await expect(
				runUpdateAttackSurface(ctx, [
					{ domain: "example.com", primary: true, headers: [] },
					{ domain, primary: false, headers: [] },
				]),
			).rejects.toMatchObject({
				data: {
					error: "validation_error",
					message:
						"attack_surface[1].domain must be a public lowercase DNS hostname",
				},
			});
			expect(patches).toEqual([]);
		},
	);
});
