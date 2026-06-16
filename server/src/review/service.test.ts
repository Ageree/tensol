import type { Database } from "bun:sqlite";
/**
 * Tests for the review persistence service (003-whitebox).
 * In-memory bun:sqlite with all migrations applied (mirrors the repo's
 * scan-orders test harness).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { type DB, createDb } from "../db/client.ts";
import {
	auditLog as auditLogTable,
	installations as installationsTable,
	reviewExecutionArtifacts as reviewExecutionArtifactsTable,
	reviewFindings as reviewFindingsTable,
	reviewRepos as reviewReposTable,
	reviewSuppressions as reviewSuppressionsTable,
	reviewThreads as reviewThreadsTable,
	reviews as reviewsTable,
} from "../db/schema.ts";
import { createReviewService } from "./service.ts";
import type { ReviewResult } from "./types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const KEY = "test-key-review-service-0123456789abcdef0123456789abcdef";

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

let clockNow = 1_700_000_000_000;
const clock = () => clockNow++;

function makeSvc(db: DB) {
	return createReviewService({ db, auditKey: KEY, now: clock });
}

async function seedUser(db: DB, id = "user_1"): Promise<string> {
	(db.$client as Database)
		.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
		.run(id, `${id}@x.io`, clockNow);
	return id;
}

const sampleResult = (): ReviewResult => ({
	kind: "pr",
	score0to5: 2,
	summaryMd: "Found 1 high finding.",
	findings: [
		{
			fingerprint: "abc123def4567890",
			filePath: "src/db.ts",
			startLine: 42,
			endLine: 42,
			side: "RIGHT",
			severity: "high",
			cwe: ["CWE-89"],
			cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
			cvssScore: 9.8,
			confidence: "high",
			reachable: true,
			category: "SQL Injection",
			title: "SQLi in query builder",
			rationaleMd: "User input flows unparameterized into the query.",
			pocMd: "`' OR 1=1--`",
			fixPromptMd: "Use parameterized queries.",
			source: "llm",
		},
	],
});

function atOrThrow<T>(items: readonly T[], index: number, label: string): T {
	const item = items.at(index);
	if (item === undefined) {
		throw new Error(`Expected ${label} at index ${index}`);
	}
	return item;
}

function sampleFinding(): ReviewResult["findings"][number] {
	return atOrThrow(sampleResult().findings, 0, "sample finding");
}

describe("review service", () => {
	let db: DB;
	beforeEach(async () => {
		db = freshMemDb();
		await seedUser(db);
	});

	test("upsertRepo creates then updates idempotently by (scm,owner,name)", async () => {
		const svc = makeSvc(db);
		const r1 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
			installationId: "111",
			defaultBranch: "main",
		});
		expect(r1.owner).toBe("acme");
		const r2 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
			installationId: "222",
		});
		expect(r2.id).toBe(r1.id);
		expect(r2.installationId).toBe("222");
		const found = await svc.getRepoByFullName("github", "acme", "app");
		expect(found?.id).toBe(r1.id);
	});

	test("createReview → markRunning → finalize persists findings + score + audit", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 7,
			headSha: "deadbeef",
		});
		expect(review.status).toBe("queued");

		await svc.markReviewRunning(review.id);
		const finalized = await svc.finalizeReview(review.id, sampleResult());
		expect(finalized.status).toBe("completed");
		expect(finalized.score0to5).toBe(2);
		expect(finalized.findingsCount).toBe(1);

		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(eq(reviewFindingsTable.reviewId, review.id))
			.all();
		expect(findings.length).toBe(1);
		const finding = atOrThrow(findings, 0, "persisted finding");
		expect(finding.severity).toBe("high");
		expect(JSON.parse(finding.cweJson)).toEqual(["CWE-89"]);
		const repoAfterFinalize = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo.id))
			.get();
		expect(repoAfterFinalize?.lastReviewId).toBe(review.id);

		// review_completed audit row emitted
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_completed"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("recordExecutionResult persists status, summary, artifacts, and audit", async () => {
		const svc = makeSvc(db);
		const review = await svc.createReview({ kind: "pr", userId: "user_1" });

		const updated = await svc.recordExecutionResult(review.id, {
			status: "passed",
			summaryMd: "## Runtime evidence\n\nHeadless smoke passed.",
			artifacts: [
				{
					kind: "log",
					label: "Unit tests",
					summaryMd: "Generated tests passed.",
					inlineBody: "bun test ok",
					mimeType: "text/plain",
					byteSize: 11,
				},
			],
		});

		expect(updated.executionStatus).toBe("passed");
		expect(updated.executionSummaryMd).toContain("Headless smoke");

		const artifacts = await svc.getReviewExecutionArtifacts(review.id);
		expect(artifacts.length).toBe(1);
		expect(artifacts[0]?.kind).toBe("log");
		expect(artifacts[0]?.inlineBody).toBe("bun test ok");

		const rows = db
			.select()
			.from(reviewExecutionArtifactsTable)
			.where(eq(reviewExecutionArtifactsTable.reviewId, review.id))
			.all();
		expect(rows.length).toBe(1);

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_execution_recorded"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("finalize is idempotent (re-finalize replaces findings, no dup)", async () => {
		const svc = makeSvc(db);
		const review = await svc.createReview({ kind: "pr", userId: "user_1" });
		await svc.finalizeReview(review.id, sampleResult());
		await svc.finalizeReview(review.id, sampleResult());
		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(eq(reviewFindingsTable.reviewId, review.id))
			.all();
		expect(findings.length).toBe(1);
	});

	test("failReview marks failed + emits audit", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			kind: "whitebox",
			userId: "user_1",
		});
		const failed = await svc.failReview(review.id, "clone failed");
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("clone failed");
		const repoAfterFail = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo.id))
			.get();
		expect(repoAfterFail?.lastReviewId).toBe(review.id);
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_failed"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("thread upsert dedups by (repoId, fingerprint) and tracks resolution", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 7,
		});
		await svc.upsertThread({
			reviewId: review.id,
			repoId: repo.id,
			fingerprint: "fp1",
			githubThreadId: "T_1",
		});
		const existing = await svc.getOpenThread(repo.id, "fp1");
		expect(existing?.githubThreadId).toBe("T_1");
		if (!existing) throw new Error("expected open thread");
		await svc.markThreadResolved(existing.id);
		const afterResolve = await svc.getOpenThread(repo.id, "fp1");
		expect(afterResolve).toBeNull();
		const rows = db
			.select()
			.from(reviewThreadsTable)
			.where(eq(reviewThreadsTable.fingerprint, "fp1"))
			.all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.isResolved).toBe(1);
	});

	test("recordFeedback stores a row and listDownvoted returns it", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
		});
		await svc.recordFeedback({
			repoId: repo.id,
			fingerprint: "fp1",
			signal: "down",
			commentText: "noise",
		});
		const down = await svc.listFeedback(repo.id, "down");
		expect(down.length).toBe(1);
		expect(down[0]?.commentText).toBe("noise");
	});

	test("listReviewsByRepo + getReview + getReviewFindings", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "app",
		});
		const r = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 1,
		});
		await svc.finalizeReview(r.id, sampleResult());
		const list = await svc.listReviewsByRepo(repo.id);
		expect(list.length).toBe(1);
		const got = await svc.getReview(r.id);
		expect(got?.id).toBe(r.id);
		const fs = await svc.getReviewFindings(r.id);
		expect(fs.length).toBe(1);
		expect(fs[0]?.title).toBe("SQLi in query builder");
	});

	test("list repos and reviews default to bounded recent pages", async () => {
		const svc = makeSvc(db);

		for (let i = 0; i < 105; i += 1) {
			const repo = await svc.upsertRepo({
				userId: "user_1",
				scm: "github",
				owner: "acme",
				name: `app-${i}`,
			});
			await svc.createReview({
				repoId: repo.id,
				userId: "user_1",
				kind: "pr",
				prNumber: i + 1,
			});
		}

		const repos = await svc.listReposByUser("user_1");
		expect(repos).toHaveLength(100);
		expect(repos[0]?.name).toBe("app-104");

		const reviews = await svc.listReviewsByUser("user_1");
		expect(reviews).toHaveLength(100);
		expect(reviews[0]?.prNumber).toBe(105);

		const smallReviews = await svc.listReviewsByUser("user_1", { limit: 10 });
		expect(smallReviews).toHaveLength(10);
		expect(smallReviews[0]?.prNumber).toBe(105);
	});
});

// ===========================================================================
// T005 / T006 — installations CRUD (feature 004: Sthrip PR Review connect flow)
// ===========================================================================

describe("installations service (T005/T006)", () => {
	let db: DB;
	beforeEach(async () => {
		db = freshMemDb();
		// seed two users for cross-tenant assertions
		await seedUser(db, "user_1");
		await seedUser(db, "user_2");
	});

	// ---------------------------------------------------------------------------
	// upsertInstallation — CREATE
	// ---------------------------------------------------------------------------
	test("upsertInstallation creates a new row and emits github_app_installed audit", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
			setupAction: "install",
		});

		expect(inst.id).toBeTruthy();
		expect(inst.userId).toBe("user_1");
		expect(inst.installationId).toBe("inst_111");
		expect(inst.accountLogin).toBe("acme-org");
		expect(inst.status).toBe("active");

		// Verify row is in DB
		const rows = db.select().from(installationsTable).all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.installationId).toBe("inst_111");

		// Verify signed audit was emitted
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "github_app_installed"))
			.all();
		expect(audits.length).toBe(1);
		expect(audits[0]?.userId).toBe("user_1");
	});

	// ---------------------------------------------------------------------------
	// upsertInstallation — UPSERT (idempotent update by installationId)
	// ---------------------------------------------------------------------------
	test("upsertInstallation updates existing row by (scm, installationId) — no duplicate row", async () => {
		const svc = makeSvc(db);
		const i1 = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});
		const i2 = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected", // changed
		});

		expect(i2.id).toBe(i1.id);
		expect(i2.repositorySelection).toBe("selected");

		const rows = db.select().from(installationsTable).all();
		expect(rows.length).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// getInstallationByGithubId
	// ---------------------------------------------------------------------------
	test("getInstallationByGithubId returns the matching installation or null", async () => {
		const svc = makeSvc(db);
		await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const found = await svc.getInstallationByGithubId("github", "inst_111");
		expect(found).not.toBeNull();
		expect(found?.accountLogin).toBe("acme-org");

		const missing = await svc.getInstallationByGithubId(
			"github",
			"does_not_exist",
		);
		expect(missing).toBeNull();
	});

	// ---------------------------------------------------------------------------
	// getInstallationsForUser — multi-tenant isolation
	// ---------------------------------------------------------------------------
	test("getInstallationsForUser returns only this user's installations", async () => {
		const svc = makeSvc(db);
		await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});
		await svc.upsertInstallation({
			userId: "user_2",
			scm: "github",
			installationId: "inst_222",
			accountLogin: "other-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const user1Installs = await svc.getInstallationsForUser("user_1");
		expect(user1Installs.length).toBe(1);
		expect(user1Installs[0]?.installationId).toBe("inst_111");

		const user2Installs = await svc.getInstallationsForUser("user_2");
		expect(user2Installs.length).toBe(1);
		expect(user2Installs[0]?.installationId).toBe("inst_222");
	});

	// ---------------------------------------------------------------------------
	// Cross-tenant: installation belongs to exactly one userId
	// ---------------------------------------------------------------------------
	test("installation owner is immutable without explicit verification", async () => {
		const svc = makeSvc(db);
		const original = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const unchanged = await svc.upsertInstallation({
			userId: "user_2",
			scm: "github",
			installationId: "inst_111", // same external id
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
			setupAction: "update",
		});

		const rows = db.select().from(installationsTable).all();
		expect(rows.length).toBe(1);
		expect(unchanged.id).toBe(original.id);
		expect(rows[0]?.userId).toBe("user_1");
		expect(rows[0]?.setupAction).toBeNull();
		expect(await svc.getInstallationsForUser("user_1")).toHaveLength(1);
		expect(await svc.getInstallationsForUser("user_2")).toHaveLength(0);
	});

	test("installation can rebind after explicit owner verification", async () => {
		const svc = makeSvc(db);
		const original = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const rebound = await svc.upsertInstallation({
			userId: "user_2",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
			setupAction: "update",
			ownerVerification: {
				provider: "github_oauth_user_installations",
				installationIds: ["inst_111"],
			},
		});

		const rows = db.select().from(installationsTable).all();
		expect(rows.length).toBe(1);
		expect(rebound.id).toBe(original.id);
		expect(rows[0]?.userId).toBe("user_2");
		expect(rows[0]?.setupAction).toBe("update");
		expect(await svc.getInstallationsForUser("user_1")).toHaveLength(0);
		expect(await svc.getInstallationsForUser("user_2")).toHaveLength(1);
	});

	// ---------------------------------------------------------------------------
	// markInstallationDeleted — cascade disables review_repos
	// ---------------------------------------------------------------------------
	test("markInstallationDeleted sets status=deleted and emits github_app_uninstalled", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		await svc.markInstallationDeleted(inst.installationId);

		const row = db
			.select()
			.from(installationsTable)
			.where(eq(installationsTable.id, inst.id))
			.get();
		expect(row?.status).toBe("deleted");

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "github_app_uninstalled"))
			.all();
		expect(audits.length).toBe(1);
		expect(audits[0]?.userId).toBe("user_1");
	});

	test("markInstallationDeleted cascade-disables linked review_repos (sets enabled=0)", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		// Connect a repo linked to this installation
		const repo1 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme-org",
			name: "repo-a",
			installationId: "inst_111",
		});
		// Link the repo to the installation row
		db.update(reviewReposTable)
			.set({ installationRowId: inst.id })
			.where(eq(reviewReposTable.id, repo1.id))
			.run();

		// Another repo NOT linked to this installation (should remain enabled)
		const repo2 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme-org",
			name: "repo-b",
			installationId: "inst_other",
		});

		await svc.markInstallationDeleted(inst.installationId);

		const r1 = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo1.id))
			.get();
		expect(r1?.enabled).toBe(0);

		// repo2 is NOT linked to this installation — must remain enabled
		const r2 = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo2.id))
			.get();
		expect(r2?.enabled).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// setInstallationStatus — suspend / unsuspend
	// ---------------------------------------------------------------------------
	test("setInstallationStatus(suspended) updates status and emits github_app_suspended", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		await svc.setInstallationStatus(inst.installationId, "suspended");

		const row = db
			.select()
			.from(installationsTable)
			.where(eq(installationsTable.id, inst.id))
			.get();
		expect(row?.status).toBe("suspended");

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "github_app_suspended"))
			.all();
		expect(audits.length).toBe(1);
		expect(audits[0]?.userId).toBe("user_1");
	});

	test("setInstallationStatus(active) unsuspends without emitting a second suspended audit", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_111",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		await svc.setInstallationStatus(inst.installationId, "suspended");
		await svc.setInstallationStatus(inst.installationId, "active");

		const row = db
			.select()
			.from(installationsTable)
			.where(eq(installationsTable.id, inst.id))
			.get();
		expect(row?.status).toBe("active");

		// Only ONE suspended audit (for the suspend call)
		const suspendedAudits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "github_app_suspended"))
			.all();
		expect(suspendedAudits.length).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// Verify audit chain integrity (prev_signature linkage)
	// ---------------------------------------------------------------------------
	test("audit chain: each row's prev_signature matches the preceding row's signature", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_chain",
			accountLogin: "chain-org",
			accountType: "Organization",
			repositorySelection: "all",
		});
		await svc.setInstallationStatus(inst.installationId, "suspended");
		await svc.markInstallationDeleted(inst.installationId);

		const allAudits = db
			.select()
			.from(auditLogTable)
			.all()
			.sort((a, b) => a.id - b.id);

		for (let i = 1; i < allAudits.length; i++) {
			const prev = atOrThrow(allAudits, i - 1, "previous audit row");
			const curr = atOrThrow(allAudits, i, "current audit row");
			expect(curr.prevSignature).toBe(prev.signature);
		}
	});
});

// ===========================================================================
// Wave-2 service methods — connect flow + routes (T013–T016)
// ===========================================================================

describe("Wave-2 service methods (T013–T016)", () => {
	let db: DB;
	beforeEach(async () => {
		db = freshMemDb();
		await seedUser(db, "user_1");
		await seedUser(db, "user_2");
	});

	// ---------------------------------------------------------------------------
	// getInstallationByRowId
	// ---------------------------------------------------------------------------
	test("getInstallationByRowId returns installation by PK or null", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_r1",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		const found = await svc.getInstallationByRowId(inst.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(inst.id);
		expect(found?.installationId).toBe("inst_r1");

		const missing = await svc.getInstallationByRowId("non_existent_row_id");
		expect(missing).toBeNull();
	});

	// ---------------------------------------------------------------------------
	// reconcileInstallationRepos
	// ---------------------------------------------------------------------------
	test("reconcileInstallationRepos upserts repos linked to the installation row", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_r2",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		await svc.reconcileInstallationRepos({
			installationRowId: inst.id,
			installationId: "inst_r2",
			userId: "user_1",
			selection: "all",
			repos: [
				{ owner: "acme-org", name: "repo-a", defaultBranch: "main" },
				{ owner: "acme-org", name: "repo-b", defaultBranch: "develop" },
			],
		});

		const repos = db.select().from(reviewReposTable).all();
		expect(repos.length).toBe(2);
		// When selection=all, repos should have enabled=1
		for (const r of repos) {
			expect(r.enabled).toBe(1);
			expect(r.installationRowId).toBe(inst.id);
			expect(r.userId).toBe("user_1");
		}
	});

	test("reconcileInstallationRepos with selection=all auto-enables repos", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_r3",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "all",
		});

		await svc.reconcileInstallationRepos({
			installationRowId: inst.id,
			installationId: "inst_r3",
			userId: "user_1",
			selection: "all",
			repos: [{ owner: "acme-org", name: "auto-repo", defaultBranch: "main" }],
		});

		const repos = db.select().from(reviewReposTable).all();
		expect(repos.length).toBe(1);
		expect(repos[0]?.enabled).toBe(1);
	});

	test("reconcileInstallationRepos is idempotent — calling twice produces one row", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_r4",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected",
		});

		const repoList = [
			{ owner: "acme-org", name: "dedup-repo", defaultBranch: "main" },
		];
		await svc.reconcileInstallationRepos({
			installationRowId: inst.id,
			installationId: "inst_r4",
			userId: "user_1",
			selection: "selected",
			repos: repoList,
		});
		await svc.reconcileInstallationRepos({
			installationRowId: inst.id,
			installationId: "inst_r4",
			userId: "user_1",
			selection: "selected",
			repos: repoList,
		});

		const repos = db.select().from(reviewReposTable).all();
		expect(repos.length).toBe(1);
	});

	test("reconcileInstallationRepos with selection=selected enables new repos (enabled=1)", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_r5",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected",
		});

		await svc.reconcileInstallationRepos({
			installationRowId: inst.id,
			installationId: "inst_r5",
			userId: "user_1",
			selection: "selected",
			repos: [{ owner: "acme-org", name: "sel-repo" }],
		});

		const repos = db.select().from(reviewReposTable).all();
		expect(repos.length).toBe(1);
		// New repos with selection=selected are enabled=1 (GitHub filtered them already)
		expect(repos[0]?.enabled).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// updateRepoSettings — owner-scoped
	// ---------------------------------------------------------------------------
	test("updateRepoSettings returns null for non-owner (owner-scoped 403 guard)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "guarded",
		});

		// user_2 tries to update user_1's repo
		const result = await svc.updateRepoSettings({
			repoId: repo.id,
			userId: "user_2",
			enabled: false,
		});
		expect(result).toBeNull();

		// repo remains unchanged
		const row = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo.id))
			.get();
		expect(row?.enabled).toBe(1);
	});

	test("updateRepoSettings updates enabled field and emits review_repo_enabled audit", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "toggle-repo",
		});

		// Disable first
		const disabled = await svc.updateRepoSettings({
			repoId: repo.id,
			userId: "user_1",
			enabled: false,
		});
		expect(disabled).not.toBeNull();
		expect(disabled?.enabled).toBe(0);

		const disabledAudits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_repo_disabled"))
			.all();
		expect(disabledAudits.length).toBe(1);

		// Re-enable
		const enabled = await svc.updateRepoSettings({
			repoId: repo.id,
			userId: "user_1",
			enabled: true,
		});
		expect(enabled).not.toBeNull();
		expect(enabled?.enabled).toBe(1);

		const enabledAudits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_repo_enabled"))
			.all();
		expect(enabledAudits.length).toBe(1);
	});

	test("updateRepoSettings updates coveredBranches and emits review_settings_changed", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "branch-repo",
		});

		const updated = await svc.updateRepoSettings({
			repoId: repo.id,
			userId: "user_1",
			coveredBranches: ["main", "develop"],
		});

		expect(updated).not.toBeNull();
		if (!updated) throw new Error("expected updated repo settings");
		expect(JSON.parse(updated.coveredBranchesJson)).toEqual([
			"main",
			"develop",
		]);

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_settings_changed"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("updateRepoSettings updates statusCheckEnabled and mergeBlockOnCritical", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "flags-repo",
		});

		const updated = await svc.updateRepoSettings({
			repoId: repo.id,
			userId: "user_1",
			statusCheckEnabled: false,
			mergeBlockOnCritical: true,
		});

		expect(updated).not.toBeNull();
		expect(updated?.statusCheckEnabled).toBe(0);
		expect(updated?.mergeBlockOnCritical).toBe(1);

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_settings_changed"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("updateRepoSettings returns null for missing repo id", async () => {
		const svc = makeSvc(db);
		const result = await svc.updateRepoSettings({
			repoId: "nonexistent_repo_id",
			userId: "user_1",
			enabled: true,
		});
		expect(result).toBeNull();
	});

	// ---------------------------------------------------------------------------
	// setReposEnabledBySlugs
	// ---------------------------------------------------------------------------
	test("setReposEnabledBySlugs enables repos by owner/name slug", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_s1",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected",
		});

		// Create repos linked to this installation
		const repo1 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme-org",
			name: "repo-x",
			installationId: "inst_s1",
		});
		db.update(reviewReposTable)
			.set({ installationRowId: inst.id, enabled: 0 })
			.where(eq(reviewReposTable.id, repo1.id))
			.run();

		const repo2 = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme-org",
			name: "repo-y",
			installationId: "inst_s1",
		});
		db.update(reviewReposTable)
			.set({ installationRowId: inst.id, enabled: 0 })
			.where(eq(reviewReposTable.id, repo2.id))
			.run();

		await svc.setReposEnabledBySlugs({
			installationId: "inst_s1",
			userId: "user_1",
			slugs: ["acme-org/repo-x"],
			enabled: true,
		});

		const r1 = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo1.id))
			.get();
		const r2 = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo2.id))
			.get();
		expect(r1?.enabled).toBe(1);
		// repo2 was not in the slugs list — unchanged
		expect(r2?.enabled).toBe(0);
	});

	test("setReposEnabledBySlugs disables repos by owner/name slug", async () => {
		const svc = makeSvc(db);
		const inst = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_s2",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected",
		});

		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme-org",
			name: "to-disable",
			installationId: "inst_s2",
		});
		db.update(reviewReposTable)
			.set({ installationRowId: inst.id })
			.where(eq(reviewReposTable.id, repo.id))
			.run();

		await svc.setReposEnabledBySlugs({
			installationId: "inst_s2",
			userId: "user_1",
			slugs: ["acme-org/to-disable"],
			enabled: false,
		});

		const r = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo.id))
			.get();
		expect(r?.enabled).toBe(0);
	});

	test("setReposEnabledBySlugs is owner-scoped — cross-tenant slug match ignored", async () => {
		const svc = makeSvc(db);
		// user_1's installation
		const inst1 = await svc.upsertInstallation({
			userId: "user_1",
			scm: "github",
			installationId: "inst_s3",
			accountLogin: "acme-org",
			accountType: "Organization",
			repositorySelection: "selected",
		});

		// user_2's repo (different installation)
		await seedUser(db, "user_3");
		const repo2 = await svc.upsertRepo({
			userId: "user_3",
			scm: "github",
			owner: "acme-org",
			name: "victim-repo",
			installationId: "inst_s3_other",
		});

		// user_1 tries to disable a repo it doesn't own via setReposEnabledBySlugs
		// The method should only match repos belonging to user_1 under inst_s3
		await svc.setReposEnabledBySlugs({
			installationId: inst1.installationId,
			userId: "user_1",
			slugs: ["acme-org/victim-repo"],
			enabled: false,
		});

		// user_3's repo must remain enabled
		const r = db
			.select()
			.from(reviewReposTable)
			.where(eq(reviewReposTable.id, repo2.id))
			.get();
		expect(r?.enabled).toBe(1);
	});
});

// ===========================================================================
// Wave-3 service additions (T042, T045 — feature 004: Sthrip PR Review)
// finalizeReview persistence, resolveThreadByFingerprint, suppressions, hasRunningReview
// ===========================================================================

describe("Wave-3 service methods (T042/T045)", () => {
	let db: DB;
	beforeEach(async () => {
		db = freshMemDb();
		await seedUser(db, "user_1");
		await seedUser(db, "user_2");
	});

	// ---------------------------------------------------------------------------
	// finalizeReview — persists verificationStatus + reachabilityEvidenceMd
	// ---------------------------------------------------------------------------
	test("finalizeReview persists verificationStatus and reachabilityEvidenceMd on findings", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "veri-test",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 42,
		});

		const result: ReviewResult = {
			kind: "pr",
			score0to5: 3,
			summaryMd: "Verified finding.",
			findings: [
				{
					...sampleFinding(),
					verificationStatus: "verified",
					reachabilityEvidenceMd: "Taint path: userInput → sink at line 42.",
				},
			],
		};

		await svc.finalizeReview(review.id, result);

		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(eq(reviewFindingsTable.reviewId, review.id))
			.all();

		expect(findings.length).toBe(1);
		expect(findings[0]?.verificationStatus).toBe("verified");
		expect(findings[0]?.reachabilityEvidenceMd).toBe(
			"Taint path: userInput → sink at line 42.",
		);
	});

	test("finalizeReview defaults verificationStatus to 'unverified' when not provided", async () => {
		const svc = makeSvc(db);
		const review = await svc.createReview({ kind: "pr", userId: "user_1" });

		// sampleResult() findings have no verificationStatus
		await svc.finalizeReview(review.id, sampleResult());

		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(eq(reviewFindingsTable.reviewId, review.id))
			.all();

		expect(findings.length).toBe(1);
		expect(findings[0]?.verificationStatus).toBe("unverified");
		expect(findings[0]?.reachabilityEvidenceMd).toBeNull();
	});

	test("finalizeReview persists 'refuted' verificationStatus", async () => {
		const svc = makeSvc(db);
		const review = await svc.createReview({ kind: "pr", userId: "user_1" });

		const result: ReviewResult = {
			kind: "pr",
			score0to5: 4,
			summaryMd: "Refuted.",
			findings: [
				{
					...sampleFinding(),
					verificationStatus: "refuted",
				},
			],
		};

		await svc.finalizeReview(review.id, result);

		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(eq(reviewFindingsTable.reviewId, review.id))
			.all();

		expect(findings[0]?.verificationStatus).toBe("refuted");
		expect(findings[0]?.reachabilityEvidenceMd).toBeNull();
	});

	// ---------------------------------------------------------------------------
	// resolveThreadByFingerprint — mark thread + finding resolved
	// ---------------------------------------------------------------------------
	test("resolveThreadByFingerprint marks thread resolved and finding lifecycleState=resolved", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "resolve-test",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 7,
		});
		await svc.upsertThread({
			reviewId: review.id,
			repoId: repo.id,
			fingerprint: "fp-resolve",
			githubThreadId: "T_resolve",
		});

		const result: ReviewResult = {
			kind: "pr",
			score0to5: 2,
			summaryMd: "Finding to resolve.",
			findings: [{ ...sampleFinding(), fingerprint: "fp-resolve" }],
		};
		await svc.finalizeReview(review.id, result);

		await svc.resolveThreadByFingerprint({
			repoId: repo.id,
			fingerprint: "fp-resolve",
		});

		// Thread should be resolved
		const thread = await svc.getOpenThread(repo.id, "fp-resolve");
		expect(thread).toBeNull();

		// Finding lifecycleState should be 'resolved'
		const findings = db
			.select()
			.from(reviewFindingsTable)
			.where(
				and(
					eq(reviewFindingsTable.reviewId, review.id),
					eq(reviewFindingsTable.fingerprint, "fp-resolve"),
				),
			)
			.all();
		expect(findings.length).toBeGreaterThan(0);
		for (const f of findings) {
			expect(f.lifecycleState).toBe("resolved");
		}

		// Emits review_thread_resolved audit
		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_thread_resolved"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("resolveThreadByFingerprint is a no-op when thread does not exist", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "no-thread",
		});

		// Should not throw
		await svc.resolveThreadByFingerprint({
			repoId: repo.id,
			fingerprint: "nonexistent-fp",
		});

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_thread_resolved"))
			.all();
		expect(audits.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// writeSuppression — upsert review_suppressions
	// ---------------------------------------------------------------------------
	test("writeSuppression creates a suppression row and emits review_category_suppressed", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "supp-test",
		});

		await svc.writeSuppression({
			repoId: repo.id,
			category: "style",
			reason: "ignored_n_times",
			ignoreCount: 3,
		});

		const rows = db
			.select()
			.from(reviewSuppressionsTable)
			.where(eq(reviewSuppressionsTable.repoId, repo.id))
			.all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.category).toBe("style");
		expect(rows[0]?.reason).toBe("ignored_n_times");
		expect(rows[0]?.ignoreCount).toBe(3);

		const audits = db
			.select()
			.from(auditLogTable)
			.where(eq(auditLogTable.event, "review_category_suppressed"))
			.all();
		expect(audits.length).toBe(1);
	});

	test("writeSuppression upserts (idempotent) by (repoId, category)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "supp-upsert",
		});

		await svc.writeSuppression({
			repoId: repo.id,
			category: "nit",
			reason: "ignored_n_times",
			ignoreCount: 3,
		});
		await svc.writeSuppression({
			repoId: repo.id,
			category: "nit",
			reason: "manual",
			ignoreCount: 5,
		});

		const rows = db
			.select()
			.from(reviewSuppressionsTable)
			.where(eq(reviewSuppressionsTable.repoId, repo.id))
			.all();
		expect(rows.length).toBe(1); // upserted, not duplicated
		expect(rows[0]?.ignoreCount).toBe(5);
		expect(rows[0]?.reason).toBe("manual");
	});

	test("writeSuppression REFUSES to write category='security' (invariant)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "supp-guard",
		});

		await expect(
			svc.writeSuppression({
				repoId: repo.id,
				category: "security",
				reason: "manual",
				ignoreCount: 10,
			}),
		).rejects.toThrow();

		const rows = db
			.select()
			.from(reviewSuppressionsTable)
			.where(eq(reviewSuppressionsTable.repoId, repo.id))
			.all();
		expect(rows.length).toBe(0);
	});

	test("writeSuppression REFUSES to write category='correctness' (invariant)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "supp-guard-correctness",
		});

		await expect(
			svc.writeSuppression({
				repoId: repo.id,
				category: "correctness",
				reason: "ignored_n_times",
				ignoreCount: 5,
			}),
		).rejects.toThrow();

		const rows = db
			.select()
			.from(reviewSuppressionsTable)
			.where(eq(reviewSuppressionsTable.repoId, repo.id))
			.all();
		expect(rows.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// listSuppressions
	// ---------------------------------------------------------------------------
	test("listSuppressions returns all suppressions for a repo", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "list-supp",
		});

		await svc.writeSuppression({
			repoId: repo.id,
			category: "style",
			reason: "ignored_n_times",
			ignoreCount: 3,
		});
		await svc.writeSuppression({
			repoId: repo.id,
			category: "nit",
			reason: "manual",
			ignoreCount: 0,
		});

		const suppressions = await svc.listSuppressions(repo.id);
		expect(suppressions.length).toBe(2);
		const categories = suppressions.map((s) => s.category).sort();
		expect(categories).toEqual(["nit", "style"]);
	});

	test("listSuppressions returns empty for a repo with none", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "empty-supp",
		});

		const suppressions = await svc.listSuppressions(repo.id);
		expect(suppressions.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// hasRunningReview — concurrency guard
	// ---------------------------------------------------------------------------
	test("hasRunningReview returns false when no reviews exist for (repoId, prNumber)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "concurrency-test",
		});

		const running = await svc.hasRunningReview(repo.id, 42);
		expect(running).toBe(false);
	});

	test("hasRunningReview returns false when review is queued (not running)", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "concurrency-q",
		});
		await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 5,
		});

		const running = await svc.hasRunningReview(repo.id, 5);
		expect(running).toBe(false);
	});

	test("hasRunningReview returns true when a review with status=running exists for that PR", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "concurrency-r",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 99,
		});
		await svc.markReviewRunning(review.id);

		const running = await svc.hasRunningReview(repo.id, 99);
		expect(running).toBe(true);
	});

	test("hasRunningReview returns false once review is completed", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "concurrency-c",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 11,
		});
		await svc.markReviewRunning(review.id);
		await svc.finalizeReview(review.id, sampleResult());

		const running = await svc.hasRunningReview(repo.id, 11);
		expect(running).toBe(false);
	});

	test("hasRunningReview is scoped to (repoId, prNumber) — different PR not affected", async () => {
		const svc = makeSvc(db);
		const repo = await svc.upsertRepo({
			userId: "user_1",
			scm: "github",
			owner: "acme",
			name: "concurrency-scope",
		});
		const review = await svc.createReview({
			repoId: repo.id,
			userId: "user_1",
			kind: "pr",
			prNumber: 7,
		});
		await svc.markReviewRunning(review.id);

		// Different PR number — should be false
		const running = await svc.hasRunningReview(repo.id, 8);
		expect(running).toBe(false);
	});
});
