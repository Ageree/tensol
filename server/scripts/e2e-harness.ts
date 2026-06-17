/**
 * 005-whitebox-mdash — REAL-MODEL E2E for the MDASH multi-model agentic harness.
 *
 * Runs the full harness (Prepare → Scan auditors → Validate debaters) against a
 * set of FRESH, comment-free fixtures (no "VULNERABLE" giveaways) spanning
 * several vuln classes PLUS safe decoys that *look* dangerous — so we measure
 * BOTH recall on real vulns AND false-positive resistance on decoys, with a REAL
 * GLM-5.2-backed harness. Spend is hard-capped by the shared per-scan budget.
 *
 * MANUAL dev script — NOT part of `bun test` / CI (paid network calls).
 *
 * Usage (from server/):
 *   TENSOL_OPENROUTER_API_KEY=<openrouter-key> bun run scripts/e2e-harness.ts
 *   # optional: TENSOL_HARNESS_MODEL_COUNTERPOINT=anthropic/claude-... (else auto-picked)
 *   #           TENSOL_HARNESS_BUDGET_USD=2  TENSOL_HARNESS_MAX_AUDITORS=6
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBudget } from "../src/exploit/budget.ts";
import { buildHarnessModels } from "../src/review/harness/models.ts";
import { runHarness } from "../src/review/harness/orchestrator.ts";
import { createOpenRouterClient } from "../src/review/llm/openrouter.ts";
import { createJoernClient } from "../src/review/reachability/joern.ts";
import { fileToDiffFile } from "../src/review/repo-fetch.ts";
import {
	CompositeSastRunner,
	createCliSastRunner,
} from "../src/review/sast/runner.ts";
import type { DiffFile } from "../src/review/types.ts";

const apiKey =
	process.env.TENSOL_OPENROUTER_API_KEY ||
	process.env.TENSOL_REVIEW_LLM_API_KEY ||
	"";
if (!apiKey) {
	console.error(
		"\n✗ No OpenRouter key. Set TENSOL_OPENROUTER_API_KEY and re-run.\n",
	);
	process.exit(1);
}
const baseUrl =
	process.env.TENSOL_REVIEW_LLM_BASE_URL || "https://openrouter.ai/api/v1";
const auditorModel =
	process.env.TENSOL_HARNESS_MODEL_AUDITOR || "z-ai/glm-5.2";
const debaterModel =
	process.env.TENSOL_HARNESS_MODEL_DEBATER || "z-ai/glm-5.2";
const reconModel = process.env.TENSOL_HARNESS_MODEL_RECON || "z-ai/glm-5.2";
const budgetUsd = Number(process.env.TENSOL_HARNESS_BUDGET_USD || "2");
const maxAuditors = Number(process.env.TENSOL_HARNESS_MAX_AUDITORS || "6");

const usd = (n: number) => `$${n.toFixed(4)}`;

// ---------------------------------------------------------------------------
// Fixtures — fresh, comment-free, ground-truth-labeled (no giveaway tells).
// ---------------------------------------------------------------------------
interface Fixture {
	path: string;
	vulnerable: boolean;
	label: string;
	src: string;
}

const FIXTURES: Fixture[] = [
	{
		path: "src/handlers/search.ts",
		vulnerable: true,
		label: "SQLi (string-interpolated query)",
		src: `import type { Database } from "bun:sqlite";
export function searchUsers(req: { query: Record<string, string> }, db: Database) {
  const term = req.query.name ?? "";
  return db.query(\`SELECT id, email FROM users WHERE name LIKE '%\${term}%'\`).all();
}
`,
	},
	{
		path: "src/handlers/report.ts",
		vulnerable: true,
		label: "OS command injection",
		src: `import { execSync } from "node:child_process";
export function generateReport(req: { query: Record<string, string> }) {
  const name = req.query.file ?? "report";
  return execSync(\`/usr/bin/genreport --out /tmp/\${name}.pdf\`).toString();
}
`,
	},
	{
		path: "src/handlers/files.ts",
		vulnerable: true,
		label: "path traversal (unsanitized join)",
		src: `import { readFileSync } from "node:fs";
import { join } from "node:path";
export function download(req: { query: Record<string, string> }) {
  const name = req.query.path ?? "index.html";
  return readFileSync(join("/var/www/uploads", name), "utf8");
}
`,
	},
	{
		path: "src/handlers/account.ts",
		vulnerable: true,
		label: "IDOR / broken access control",
		src: `import type { Database } from "bun:sqlite";
export function getInvoice(req: { params: { id: string }; userId: string }, db: Database) {
  // returns any invoice by id with no ownership check
  return db.query("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
}
`,
	},
	{
		path: "src/safe/query.ts",
		vulnerable: false,
		label: "DECOY: parameterized query (safe)",
		src: `import type { Database } from "bun:sqlite";
export function findUser(req: { query: Record<string, string> }, db: Database) {
  const term = req.query.name ?? "";
  return db.query("SELECT id, email FROM users WHERE name LIKE ?").all(\`%\${term}%\`);
}
`,
	},
	{
		path: "src/safe/exec.ts",
		vulnerable: false,
		label: "DECOY: execFile + allowlist (safe)",
		src: `import { execFileSync } from "node:child_process";
const ALLOWED = new Set(["daily", "weekly", "monthly"]);
export function runJob(req: { query: Record<string, string> }) {
  const kind = req.query.kind ?? "daily";
  if (!ALLOWED.has(kind)) throw new Error("invalid job");
  return execFileSync("/usr/bin/genreport", ["--kind", kind]).toString();
}
`,
	},
];

// ---------------------------------------------------------------------------
// Resolve the counterpoint model. Default stays on GLM-5.2; operators can set
// TENSOL_HARNESS_MODEL_COUNTERPOINT explicitly when they want a heterogeneous run.
// ---------------------------------------------------------------------------
async function resolveCounterpoint(): Promise<{
	model: string;
	distinct: boolean;
}> {
	const fromEnv = process.env.TENSOL_HARNESS_MODEL_COUNTERPOINT?.trim();
	if (fromEnv) return { model: fromEnv, distinct: fromEnv !== auditorModel };
	return { model: auditorModel, distinct: false };
}

async function main() {
	console.log("\n=== MDASH harness real-model E2E ===");
	const { model: counterpointModel, distinct } = await resolveCounterpoint();
	console.log(`  auditor      = ${auditorModel}`);
	console.log(`  debater (R1) = ${debaterModel}`);
	console.log(
		`  counterpoint = ${counterpointModel}${distinct ? "" : "  (FALLBACK — not a true 3-model ensemble)"}`,
	);
	console.log(`  recon/triage = ${reconModel}`);
	console.log(
		`  budget       = ${usd(budgetUsd)}  maxAuditors=${maxAuditors}\n`,
	);

	// Materialize fixtures on disk (the harness tools read from repoDir).
	const repoDir = mkdtempSync(join(tmpdir(), "harness-e2e-"));
	for (const f of FIXTURES) {
		const abs = join(repoDir, f.path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, f.src, "utf8");
	}
	// Build DiffFiles with the SAME shape production uses: fileToDiffFile (in
	// repo-fetch.ts) sets `patch` only, never `contents` — so this paid E2E
	// exercises the real source-extraction fallback (`contents ?? patch`) instead
	// of the opposite shape. The on-disk fixtures (read by the auditor tools) are
	// unaffected. (Guards the field-mismatch class that caused the prior research bug.)
	const files: DiffFile[] = FIXTURES.map((f) => fileToDiffFile(f.path, f.src));

	const budget = createBudget({
		ceilingUsd: budgetUsd,
		usdPerMTokOut: 4.4,
		usdPerMTokIn: 1.4,
	});
	const session = buildHarnessModels({
		apiKey,
		baseUrl,
		auditorModel,
		debaterModel,
		counterpointModel,
		reconModel,
		budget,
		makeClient: (a) => createOpenRouterClient(a),
	});

	const sastRunner = new CompositeSastRunner([
		createCliSastRunner({ tool: "opengrep" }),
		createCliSastRunner({ tool: "trivy" }),
		createCliSastRunner({ tool: "gitleaks" }),
	]);
	const reachability = createJoernClient();

	console.log("  running harness (real models, this costs money)…\n");
	const started = Date.now();
	const verdicts = await runHarness({ files, repoDir }, session, {
		sastRunner,
		reachability,
		opts: { maxAuditors, auditorMaxRounds: 4, debateMaxRounds: 2 },
	});
	const elapsedMs = Date.now() - started;

	// Score recall + false positives against ground truth.
	const flagged = new Set(verdicts.map((v) => v.filePath));
	const realVulns = FIXTURES.filter((f) => f.vulnerable);
	const decoys = FIXTURES.filter((f) => !f.vulnerable);
	const recalled = realVulns.filter((f) => flagged.has(f.path));
	const falsePositives = decoys.filter((f) => flagged.has(f.path));
	const debateFired = verdicts.some((v) =>
		v.rationaleMd.includes("Multi-model debate"),
	);
	const contested = verdicts.filter((v) =>
		v.rationaleMd.toLowerCase().includes("contested"),
	).length;
	const spent = budget.spentUsd();

	console.log(
		"---------------------------------------------------------------",
	);
	console.log("RESULTS");
	console.log(
		`  recall:          ${recalled.length}/${realVulns.length} real vulns flagged`,
	);
	for (const f of realVulns)
		console.log(
			`    ${flagged.has(f.path) ? "✓" : "✗"} ${f.label} (${f.path})`,
		);
	console.log(
		`  false positives: ${falsePositives.length}/${decoys.length} decoys flagged`,
	);
	for (const f of decoys)
		console.log(
			`    ${flagged.has(f.path) ? "✗ FP" : "✓ ok"} ${f.label} (${f.path})`,
		);
	console.log(`  total verdicts:  ${verdicts.length}`);
	console.log(
		`  multi-model debate fired: ${debateFired ? "yes" : "NO"}  (contested findings: ${contested})`,
	);
	console.log(
		`  spend:           ${usd(spent)} / ${usd(budgetUsd)}   elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
	);
	console.log(
		"---------------------------------------------------------------\n",
	);

	rmSync(repoDir, { recursive: true, force: true });

	// Pass criteria (the user's standard: ~$0 spend = short-circuit = FAIL).
	const failures: string[] = [];
	if (spent <= 0)
		failures.push(
			"zero spend → the harness short-circuited (models never ran)",
		);
	if (spent > budgetUsd + 1e-6)
		failures.push(`spend ${usd(spent)} exceeded the ${usd(budgetUsd)} ceiling`);
	if (recalled.length < realVulns.length - 1)
		failures.push(
			`recall ${recalled.length}/${realVulns.length} below threshold (allow at most 1 miss)`,
		);
	if (falsePositives.length > 1)
		failures.push(
			`${falsePositives.length} false positives on decoys (allow at most 1)`,
		);
	if (!debateFired)
		failures.push(
			"multi-model debate never fired (Validate stage did not run)",
		);

	if (failures.length > 0) {
		console.error("✗ E2E FAILED:");
		for (const f of failures) console.error(`   - ${f}`);
		process.exit(1);
	}
	console.log(
		"✓ E2E PASSED — multi-model agentic harness recalled the vulns, resisted decoys, debated, and stayed in budget.\n",
	);
}

main().catch((e) => {
	console.error("\n✗ E2E crashed:", e);
	process.exit(1);
});
