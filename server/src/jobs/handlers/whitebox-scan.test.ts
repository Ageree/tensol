/**
 * 005-whitebox-mdash — whitebox_scan handler harness-wiring tests.
 * Focused on the decision: deep + harness dep + repoDir → run the harness runner.
 */
import { expect, test } from "bun:test";
import type { Review, ReviewRepo } from "../../db/schema.ts";
import type {
	HarnessRunner,
	HarnessSession,
} from "../../review/harness/types.ts";
import type { ReachabilityClient } from "../../review/reachability/joern.ts";
import type { ReviewResult } from "../../review/types.ts";
import {
	type WhiteboxScanHandlerDeps,
	createWhiteboxScanHandler,
} from "./whitebox-scan.ts";

const TS = 1_700_000_000_000;

const repo: ReviewRepo = {
	id: "repo1",
	userId: "u1",
	owner: "o",
	name: "n",
	scm: "github",
	installationId: null,
	defaultBranch: "main",
	coveredBranchesJson: "[]",
	rulesMd: null,
	status: "active",
	enabled: 1,
	statusCheckEnabled: 1,
	mergeBlockOnCritical: 0,
	lastReviewId: null,
	installationRowId: null,
	createdAt: TS,
	updatedAt: TS,
};

function unusedServiceMethod(
	name: string,
): (...args: unknown[]) => Promise<never> {
	return async () => {
		throw new Error(`Unexpected ReviewService.${name} call`);
	};
}

function makeDeps(over: {
	mode: "fast" | "deep";
	repoDir?: string;
	harness?: WhiteboxScanHandlerDeps["harness"];
	llm?: WhiteboxScanHandlerDeps["llm"];
	reachability?: ReachabilityClient;
	deepResearchAllowed?: boolean;
	onFinalize?: (result: ReviewResult) => void;
}): WhiteboxScanHandlerDeps {
	const review: Review = {
		id: "r1",
		status: "queued",
		repoId: "repo1",
		userId: null,
		kind: "whitebox",
		prNumber: null,
		headSha: null,
		baseSha: null,
		commitRef: null,
		mode: over.mode,
		score0to5: null,
		summaryMd: null,
		githubReviewId: null,
		findingsCount: 0,
		startedAt: null,
		completedAt: null,
		error: null,
		createdAt: TS,
		updatedAt: TS,
	};
	const service: WhiteboxScanHandlerDeps["service"] = {
		upsertRepo: unusedServiceMethod("upsertRepo"),
		getRepoByFullName: unusedServiceMethod("getRepoByFullName"),
		getRepoByInstallation: unusedServiceMethod("getRepoByInstallation"),
		getReview: async () => review,
		getRepo: async () => repo,
		listReposByUser: unusedServiceMethod("listReposByUser"),
		createReview: unusedServiceMethod("createReview"),
		createQueuedReviewWithJob: unusedServiceMethod("createQueuedReviewWithJob"),
		markReviewRunning: async () => review,
		finalizeReview: async (_id: string, result: ReviewResult) => {
			over.onFinalize?.(result);
			return review;
		},
		failReview: async () => review,
		listReviewsByRepo: unusedServiceMethod("listReviewsByRepo"),
		listReviewsByUser: unusedServiceMethod("listReviewsByUser"),
		getReviewFindings: unusedServiceMethod("getReviewFindings"),
		countFindingsByReviewIds: unusedServiceMethod("countFindingsByReviewIds"),
		upsertThread: unusedServiceMethod("upsertThread"),
		getOpenThread: unusedServiceMethod("getOpenThread"),
		markThreadResolved: unusedServiceMethod("markThreadResolved"),
		recordFeedback: unusedServiceMethod("recordFeedback"),
		listFeedback: unusedServiceMethod("listFeedback"),
		upsertInstallation: unusedServiceMethod("upsertInstallation"),
		getInstallationByGithubId: unusedServiceMethod("getInstallationByGithubId"),
		getInstallationsForUser: unusedServiceMethod("getInstallationsForUser"),
		markInstallationDeleted: unusedServiceMethod("markInstallationDeleted"),
		setInstallationStatus: unusedServiceMethod("setInstallationStatus"),
		getInstallationByRowId: unusedServiceMethod("getInstallationByRowId"),
		updateRepoSettings: unusedServiceMethod("updateRepoSettings"),
		reconcileInstallationRepos: unusedServiceMethod(
			"reconcileInstallationRepos",
		),
		setReposEnabledBySlugs: unusedServiceMethod("setReposEnabledBySlugs"),
		resolveThreadByFingerprint: unusedServiceMethod(
			"resolveThreadByFingerprint",
		),
		writeSuppression: unusedServiceMethod("writeSuppression"),
		listSuppressions: unusedServiceMethod("listSuppressions"),
		hasRunningReview: unusedServiceMethod("hasRunningReview"),
	};
	const fetcher: WhiteboxScanHandlerDeps["fetcher"] = {
		fetch: async () => ({
			files: [
				{
					path: "a.ts",
					status: "added" as const,
					contents: "const id = req.query.id; db.query(id);",
				},
			],
			...(over.repoDir !== undefined ? { repoDir: over.repoDir } : {}),
			cleanup: () => {},
		}),
	};
	return {
		service,
		fetcher,
		llm: over.llm ?? {
			complete: async () => JSON.stringify({ summary: "", verdicts: [] }),
		},
		cloneUrlFor: () => "https://example.com/o/n.git",
		deepResearchAllowed: over.deepResearchAllowed ?? true,
		...(over.harness ? { harness: over.harness } : {}),
		...(over.reachability ? { reachability: over.reachability } : {}),
	};
}

const harnessSpy = () => {
	let ran = false;
	const runner: HarnessRunner = {
		run: async () => {
			ran = true;
			return [];
		},
	};
	return {
		harness: {
			makeSession: () => ({}) as unknown as HarnessSession,
			makeRunner: () => runner,
		},
		ran: () => ran,
	};
};

test("deep review with harness dep + repoDir runs the harness runner", async () => {
	const spy = harnessSpy();
	const handler = createWhiteboxScanHandler(
		makeDeps({
			mode: "deep",
			repoDir: "/tmp/harness-test",
			harness: spy.harness,
		}),
	);
	await handler("j1", { reviewId: "r1" });
	expect(spy.ran()).toBe(true);
});

test("fast review does NOT run the harness runner", async () => {
	const spy = harnessSpy();
	const handler = createWhiteboxScanHandler(
		makeDeps({
			mode: "fast",
			repoDir: "/tmp/harness-test",
			harness: spy.harness,
		}),
	);
	await handler("j2", { reviewId: "r1" });
	expect(spy.ran()).toBe(false);
});

test("deep review WITHOUT repoDir does NOT run the harness runner (no on-disk checkout)", async () => {
	const spy = harnessSpy();
	const handler = createWhiteboxScanHandler(
		makeDeps({ mode: "deep", harness: spy.harness }),
	);
	await handler("j3", { reviewId: "r1" });
	expect(spy.ran()).toBe(false);
});

test("deep review without harness still threads reachability when repoDir exists", async () => {
	let analyzeCalls = 0;
	let finalized: ReviewResult | undefined;
	const reachability: ReachabilityClient = {
		analyze: async ({ findings }) => {
			analyzeCalls += 1;
			return Object.fromEntries(
				findings.map((finding) => [
					finding.fingerprint,
					{ reachable: true, evidenceMd: "source->sink taint path" },
				]),
			);
		},
	};
	const handler = createWhiteboxScanHandler(
		makeDeps({
			mode: "deep",
			repoDir: "/tmp/harness-test",
			llm: { complete: async ({ user }) => scriptedResearch(user) },
			reachability,
			onFinalize: (result) => {
				finalized = result;
			},
		}),
	);

	await handler("j4", { reviewId: "r1" });

	expect(analyzeCalls).toBe(1);
	expect(finalized?.findings[0]?.reachabilityEvidenceMd).toBe(
		"source->sink taint path",
	);
	expect(finalized?.findings[0]?.verificationStatus).toBe("verified");
});

function scriptedResearch(user: string): string {
	if (/routing units|scoped scenarios/i.test(user)) {
		return JSON.stringify({
			scenarios: [
				{
					id: "S001",
					expert: "injection",
					routing_unit_ids: ["U001"],
					target_paths: ["a.ts"],
					proof_question: "attacker controlled?",
					evidence_required: ["source", "sink"],
					priority: "high",
				},
			],
		});
	}
	if (/candidates to triage/i.test(user)) {
		return JSON.stringify({
			decisions: [
				{
					candidate_id: "S001-F001",
					decision: "accepted",
					confidence: "medium",
					severity_rationale: "taint path proven by reachability",
				},
			],
		});
	}
	return JSON.stringify({
		scenario_id: "S001",
		expert: "injection",
		status: "candidate",
		primary_vulnerability_class: "SQL Injection",
		summary: "id concatenated into SQL",
		evidence: [{ path: "a.ts", line: 1, snippet: "db.query", note: "sink" }],
		proof_obligations: [
			{ id: "reach", status: "needs_context", summary: "check taint" },
		],
		cwe: ["CWE-89"],
		cvss: {
			AV: "N",
			AC: "L",
			PR: "N",
			UI: "N",
			S: "U",
			C: "H",
			I: "H",
			A: "H",
		},
	});
}
