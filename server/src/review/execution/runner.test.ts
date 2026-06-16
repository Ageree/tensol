import { describe, expect, test } from "bun:test";
import {
	appendExecutionSummary,
	createRemotePrExecutionRunner,
	normalizeExecutionResult,
	signPayload,
	verifyPayloadSignature,
} from "./runner.ts";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("PR execution runner", () => {
	test("signs and verifies worker payloads", () => {
		const body = JSON.stringify({ ok: true });
		const sig = signPayload(body, "secret");
		expect(sig.startsWith("sha256=")).toBe(true);
		expect(verifyPayloadSignature(body, "secret", sig)).toBe(true);
		expect(verifyPayloadSignature(body, "wrong", sig)).toBe(false);
	});

	test("normalizes worker results and caps inline artifacts", () => {
		const result = normalizeExecutionResult(
			{
				status: "passed",
				summary_md: "## Runtime evidence",
				artifacts: [
					{
						kind: "log",
						label: "Long log",
						summary_md: "Captured stdout.",
						inline_body: "abcdef",
						mime_type: "text/plain",
						sha256:
							"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						byte_size: 6,
					},
					{ kind: "unknown", label: "drop me" },
				],
			},
			{ maxInlineBytes: 3 },
		);
		expect(result.status).toBe("passed");
		expect(result.artifacts.length).toBe(1);
		expect(result.artifacts[0]?.inlineBody).toBe("abc");
		expect(result.artifacts[0]?.sha256).toMatch(/^a+$/);
	});

	test("runtime failures lower the posted score while worker errors stay evidence-only", () => {
		const clean = {
			kind: "pr" as const,
			score0to5: 5,
			summaryMd: "Static review clean.",
			findings: [],
		};

		const failed = appendExecutionSummary(clean, {
			status: "failed",
			summaryMd: "## Runtime evidence\n\nGenerated test failed.",
			artifacts: [],
		});
		expect(failed.score0to5).toBe(2);
		expect(failed.summaryMd).toContain("Generated test failed");

		const workerError = appendExecutionSummary(clean, {
			status: "error",
			summaryMd: "## Runtime evidence\n\nWorker unavailable.",
			artifacts: [],
		});
		expect(workerError.score0to5).toBe(5);
		expect(workerError.summaryMd).toContain("Worker unavailable");
	});

	test("remote runner posts signed JSON and normalizes the response", async () => {
		const bodies: string[] = [];
		const runner = createRemotePrExecutionRunner({
			url: "https://worker.example/run",
			secret: "secret",
			fetchImpl: async (_url, init) => {
				const body = String(init?.body ?? "");
				bodies.push(body);
				expect(
					verifyPayloadSignature(
						body,
						"secret",
						(init?.headers as Record<string, string>)[
							"x-sthrip-execution-signature"
						],
					),
				).toBe(true);
				return new Response(
					JSON.stringify({
						status: "passed",
						summaryMd: "ok",
						artifacts: [],
					}),
					{ status: 200 },
				);
			},
		});

		const result = await runner.run({
			reviewId: "review-1",
			repoId: "repo-1",
			owner: "acme",
			name: "web",
			prNumber: 7,
			headSha: HEAD_SHA,
			files: [],
		});

		expect(result.status).toBe("passed");
		expect(bodies[0]).toContain(HEAD_SHA);
		const envelope = JSON.parse(bodies[0] ?? "{}");
		expect(envelope.aud).toBe("sthrip-pr-worker");
		expect(typeof envelope.nonce).toBe("string");
		expect(envelope.exp).toBeGreaterThan(envelope.iat);
	});

	test("remote runner rejects oversized worker responses before JSON parse", async () => {
		const runner = createRemotePrExecutionRunner({
			url: "https://worker.example/run",
			secret: "secret",
			fetchImpl: async () =>
				new Response("x".repeat(1_048_577), {
					status: 200,
				}),
		});

		await expect(
			runner.run({
				reviewId: "review-1",
				repoId: "repo-1",
				owner: "acme",
				name: "web",
				prNumber: 7,
				headSha: HEAD_SHA,
				files: [],
			}),
		).rejects.toThrow("response exceeded size limit");
	});
});
