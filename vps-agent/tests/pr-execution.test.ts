import { describe, expect, test } from "bun:test";
import {
	type PrExecutionInput,
	runPrExecution,
} from "../src/pr-execution.ts";

const HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GITHUB_TOKEN = "ghp_test_secret_do_not_leak";
const ENCODED_TOKEN = Buffer.from(
	`x-access-token:${GITHUB_TOKEN}`,
	"utf8",
).toString("base64");

const INPUT: PrExecutionInput = {
	reviewId: "review-vercel-1",
	repoId: "repo-vercel-1",
	owner: "acme",
	name: "web",
	prNumber: 12,
	headSha: HEAD_SHA,
};

async function withEnv(
	overrides: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const original = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		original.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		await run();
	} finally {
		for (const [key, value] of original) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function makeSandbox(opts: { failTests?: boolean } = {}) {
	const events: string[] = [];
	const createParams: unknown[] = [];
	const commands: Array<{
		cmd: string;
		args?: readonly string[];
		env?: Readonly<Record<string, string>>;
	}> = [];
	const policies: unknown[] = [];
	let stopped = false;
	const sandbox = {
		name: "sbx-test",
		runCommand: async (params: {
			cmd: string;
			args?: readonly string[];
			env?: Readonly<Record<string, string>>;
		}) => {
			commands.push(params);
			events.push(`cmd:${params.cmd} ${(params.args ?? []).join(" ")}`);
			const printable = `${params.cmd} ${(params.args ?? []).join(" ")}`;
			const isTestCommand =
				params.cmd === "sh" &&
				(params.args ?? []).some((arg) =>
					arg.includes(".sthrip-runtime-test-plan.sh"),
				);
			const secretOutput = params.env?.GIT_CONFIG_VALUE_0
				? [GITHUB_TOKEN, ENCODED_TOKEN, params.env.GIT_CONFIG_VALUE_0]
				: [];
			return {
				exitCode: opts.failTests && isTestCommand ? 1 : 0,
				output: async () =>
					[`ran ${printable}`, ...secretOutput].join("\n"),
			};
		},
		updateNetworkPolicy: async (policy: unknown) => {
			policies.push(policy);
			events.push(`policy:${String(policy)}`);
			return policy;
		},
		stop: async () => {
			stopped = true;
		},
	};
	return {
		commands,
		createParams,
		events,
		policies,
		wasStopped: () => stopped,
		createSandbox: async (params: unknown) => {
			createParams.push(params);
			return sandbox;
		},
	};
}

describe("runPrExecution — Vercel Sandbox provider", () => {
	test("runs checkout/install with setup egress, then branch tests under deny-all", async () => {
		const fake = makeSandbox();
		const result = await runPrExecution({
			input: INPUT,
			sandboxProvider: "vercel-sandbox",
			githubToken: GITHUB_TOKEN,
			vercelSandbox: { createSandbox: fake.createSandbox },
			now: () => 1700000000000,
		});

		expect(result.status).toBe("passed");
		expect(fake.createParams).toHaveLength(1);
		expect(fake.createParams[0]).toMatchObject({
			runtime: "node24",
			resources: { vcpus: 2 },
			persistent: false,
			tags: {
				app: "sthrip",
				kind: "pr-execution",
				review: INPUT.reviewId,
				repo: INPUT.repoId,
			},
		});
		expect(fake.policies).toEqual(["deny-all"]);
		const denyIndex = fake.events.indexOf("policy:deny-all");
		const testIndex = fake.events.findIndex((event) =>
			event.includes(".sthrip-runtime-test-plan.sh"),
		);
		expect(denyIndex).toBeGreaterThan(-1);
		expect(testIndex).toBeGreaterThan(denyIndex);
		expect(fake.wasStopped()).toBe(true);

		const installCommand = fake.commands.find(
			(command) =>
				command.cmd === "sh" &&
				(command.args ?? []).some((arg) => arg.includes("npm ci")),
		);
		const installScript = installCommand?.args?.[1] ?? "";
		expect(installScript).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(installScript).toContain("printf 'bun' > .sthrip-package-manager");
		expect(installScript).toContain("printf 'pnpm' > .sthrip-package-manager");
		expect(installScript).toContain("npm ci --ignore-scripts");
		expect(installScript).toContain(
			"pnpm install --frozen-lockfile --ignore-scripts",
		);
		expect(installScript).toContain(
			"yarn install --frozen-lockfile --ignore-scripts",
		);
		expect(installScript).toContain(
			"package.json found without a trusted lockfile; refusing networked install",
		);
		const setupScript = fake.commands
			.filter((command) => command.cmd === "sh")
			.map((command) => command.args?.[1] ?? "")
			.find((script) => script.includes("bun@1.3.14"));
		expect(setupScript).toContain(
			"mkdir -p .home .cache/npm \"$HOME/.sthrip-tools\"; if",
		);
		expect(setupScript).toContain(
			"npm install --prefix \"$HOME/.sthrip-tools\" --no-audit --no-fund bun@1.3.14",
		);
		expect(setupScript).not.toContain("curl -fsSL");
		expect(setupScript).not.toContain("wget -qO-");
		const testScript = fake.commands
			.filter((command) => command.cmd === "sh")
			.map((command) => command.args?.[1] ?? "")
			.find((script) => script.includes(".sthrip-runtime-test-plan.sh"));
		expect(testScript).toContain("pm === 'bun' ? `bun run ${name}`");
		expect(testScript).toContain("pm === 'pnpm' ? `pnpm run ${name}`");
		expect(testScript).toContain("pm === 'yarn' ? `yarn run ${name}`");

		const fetchCommand = fake.commands.find(
			(command) => command.cmd === "git" && command.args?.[0] === "fetch",
		);
		expect(fetchCommand?.env?.GIT_CONFIG_VALUE_0).toContain("AUTHORIZATION");
		const artifactText = result.artifacts
			.map((artifact) => artifact.inlineBody ?? "")
			.join("\n");
		expect(artifactText).not.toContain(GITHUB_TOKEN);
		expect(artifactText).not.toContain(ENCODED_TOKEN);
	});

	test("marks branch runtime failures as failed", async () => {
		const fake = makeSandbox({ failTests: true });
		const result = await runPrExecution({
			input: INPUT,
			sandboxProvider: "vercel-sandbox",
			vercelSandbox: {
				createSandbox: fake.createSandbox,
				runtime: "node24",
				vcpus: 4,
			},
			now: () => 1700000000000,
		});

		expect(result.status).toBe("failed");
		expect(result.summaryMd).toContain("Vercel Sandbox found");
		expect(fake.createParams[0]).toMatchObject({
			runtime: "node24",
			resources: { vcpus: 4 },
		});
		expect(fake.wasStopped()).toBe(true);
	});

	test("passes explicit Vercel Sandbox credentials from env to Sandbox.create", async () => {
		await withEnv(
			{
				VERCEL_TOKEN: "vercel_token_test_secret",
				VERCEL_TEAM_ID: "team_test_123",
				VERCEL_PROJECT_ID: "prj_test_123",
			},
			async () => {
				const fake = makeSandbox();
				const result = await runPrExecution({
					input: INPUT,
					sandboxProvider: "vercel-sandbox",
					vercelSandbox: { createSandbox: fake.createSandbox },
					now: () => 1700000000000,
				});

				expect(result.status).toBe("passed");
				expect(fake.createParams[0]).toMatchObject({
					token: "vercel_token_test_secret",
					teamId: "team_test_123",
					projectId: "prj_test_123",
				});
			},
		);
	});

	test("rejects partial explicit Vercel Sandbox credentials without leaking the token", async () => {
		await withEnv(
			{
				VERCEL_TOKEN: "vercel_token_partial_secret",
				VERCEL_TEAM_ID: undefined,
				VERCEL_PROJECT_ID: undefined,
			},
			async () => {
				const fake = makeSandbox();
				const result = await runPrExecution({
					input: INPUT,
					sandboxProvider: "vercel-sandbox",
					vercelSandbox: { createSandbox: fake.createSandbox },
					now: () => 1700000000000,
				});

				expect(result.status).toBe("error");
				expect(fake.createParams).toHaveLength(0);
				expect(result.artifacts[0]?.inlineBody).toContain("VERCEL_TEAM_ID");
				expect(result.artifacts[0]?.inlineBody).toContain("VERCEL_PROJECT_ID");
				expect(result.artifacts[0]?.inlineBody).not.toContain(
					"vercel_token_partial_secret",
				);
			},
		);
	});

	test("reports sandbox API command errors as worker errors", async () => {
		let stopped = false;
		const result = await runPrExecution({
			input: INPUT,
			sandboxProvider: "vercel-sandbox",
			vercelSandbox: {
				createSandbox: async () => ({
					name: "sbx-api-error",
					runCommand: async () => {
						throw new Error("vercel api unavailable");
					},
					updateNetworkPolicy: async (policy) => policy,
					stop: async () => {
						stopped = true;
					},
				}),
			},
			now: () => 1700000000000,
		});

		expect(result.status).toBe("error");
		expect(result.summaryMd).toContain("Vercel Sandbox could not execute");
		expect(result.artifacts[0]?.inlineBody).toContain("vercel api unavailable");
		expect(stopped).toBe(true);
	});
});
