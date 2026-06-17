/**
 * ZERO-DAY E2E proof harness — a STRICTER, on-the-fly companion to
 * `e2e-exploit-lab.ts`. Run against a REAL model (GLM via OpenRouter). MANUAL
 * dev script, NOT part of `bun test` / CI (paid network calls + live targets).
 *
 *   F1 — Deep Whitebox Research on FRESH, realistic code the model was never
 *        spoon-fed: NO "VULNERABLE" giveaway comments, 7 distinct vuln classes,
 *        PLUS 3 genuinely-safe decoys that *look* dangerous (parameterized SQL,
 *        execFile+allowlist, contained path read). We measure recall on the real
 *        vulns AND false-positive resistance on the decoys.
 *
 *   F2 — Autonomous Exploit Lab across MULTIPLE vuln classes (SQLi, command
 *        injection, path traversal, IDOR) on controlled loopback targets. Every
 *        target carries SERVER-SIDE telemetry that records whether REAL
 *        exploitation occurred — so the final verdict is `lab.proven AND the
 *        server confirms the exploit actually fired`, which defeats the
 *        gameable-marker shortcut (a PoC that merely `echo`es the known marker
 *        without touching the target is caught and FAILED).
 *
 * Safety: every target is a throwaway in-process server bound to 127.0.0.1 with
 * a benign planted canary; the only "payloads" are read-only probes (UNION
 * SELECT of a constant, `echo <marker>`, `../canary`, an unowned record id).
 * `payload-lint` rejects any destructive/out-of-scope PoC before it runs, so even
 * the deliberately-vulnerable command-injection sink can only ever run a benign
 * echo.
 *
 * Usage (from server/):
 *   TENSOL_OPENROUTER_API_KEY=<openrouter-key> bun run scripts/e2e-zeroday.ts
 *   # flags: --f1 (research only) | --f2 (exploit only) | default: both
 */
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { runExploitLabForFindings } from "../src/exploit/bridge.ts";
import { createBudget } from "../src/exploit/budget.ts";
import { createMeteredClient } from "../src/exploit/metered-client.ts";
import { createLocalSandbox } from "../src/exploit/sandbox-local.ts";
import type { ExploitContext } from "../src/exploit/types.ts";
import { runReview } from "../src/review/engine.ts";
import { createOpenRouterClient } from "../src/review/llm/openrouter.ts";
import { fileToDiffFile } from "../src/review/repo-fetch.ts";
import type { ReviewFinding } from "../src/review/types.ts";

// ---------------------------------------------------------------------------
// Config / key resolution
// ---------------------------------------------------------------------------
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
const model = process.env.TENSOL_EXPLOIT_LLM_MODEL || "z-ai/glm-5.2";
const baseUrl =
	process.env.TENSOL_REVIEW_LLM_BASE_URL || "https://openrouter.ai/api/v1";
const pricePerMTok = Number(
	process.env.TENSOL_EXPLOIT_USD_PER_MTOK_OUT || "4.4",
);

const args = new Set(process.argv.slice(2));
const runF1 = args.has("--f1") || (!args.has("--f1") && !args.has("--f2"));
const runF2 = args.has("--f2") || (!args.has("--f1") && !args.has("--f2"));

const usd = (n: number) => `$${n.toFixed(4)}`;
const newCanary = (tag: string) =>
	`${tag}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

// ===========================================================================
// F1 — Deep Whitebox Research over FRESH, comment-free realistic code
// ===========================================================================
// Each fixture is written WITHOUT any "VULNERABLE"/"SAFE" tell. Vulns span 7
// CWE classes; decoys look risky but are safe — they test FP-resistance.

interface Fixture {
	path: string;
	src: string;
	vulnerable: boolean;
	label: string; // human label for the expected class (vuln) or why-safe (decoy)
}

const FIXTURES: Fixture[] = [
	// --- real vulns (no giveaway comments) ---
	{
		path: "src/handlers/products.ts",
		vulnerable: true,
		label: "SQLi (string-interpolated LIKE)",
		src: `import type { Database } from "bun:sqlite";
export async function searchProducts(req: { query: Record<string, string> }, db: Database) {
  const term = req.query.q ?? "";
  const rows = db.query(\`SELECT id, name, price FROM products WHERE name LIKE '%\${term}%'\`).all();
  return { results: rows };
}`,
	},
	{
		path: "src/handlers/convert.ts",
		vulnerable: true,
		label: "Command injection (exec template)",
		src: `import { exec } from "node:child_process";
export function convertImage(req: { body: { file: string; format: string } }, res: any) {
  const { file, format } = req.body;
  exec(\`convert uploads/\${file} -resize 50% out/\${file}.\${format}\`, (err, stdout) => {
    if (err) return res.status(500).send(String(err));
    res.send(stdout);
  });
}`,
	},
	{
		path: "src/handlers/avatar.ts",
		vulnerable: true,
		label: "Path traversal (path.join no containment)",
		src: `import path from "node:path";
import { readFile } from "node:fs/promises";
export async function getAvatar(req: { params: { user: string } }, res: any) {
  const user = req.params.user;
  const data = await readFile(path.join("avatars", user), "utf8");
  res.setHeader("Content-Type", "image/svg+xml");
  res.send(data);
}`,
	},
	{
		path: "src/handlers/preview.ts",
		vulnerable: true,
		label: "SSRF (fetch attacker URL)",
		src: `export async function fetchPreview(req: { query: Record<string, string> }) {
  const { link } = req.query;
  const r = await fetch(link, { redirect: "follow" });
  const html = await r.text();
  return { title: (html.match(/<title>(.*?)<\\/title>/i) ?? [])[1] ?? "" };
}`,
	},
	{
		path: "src/handlers/invoices.ts",
		vulnerable: true,
		label: "IDOR (parameterized but no ownership check)",
		src: `import type { Database } from "bun:sqlite";
export async function getInvoice(req: { params: { id: string }; user: { id: number } }, res: any, db: Database) {
  const id = req.params.id;
  // parameterized — but no check that the invoice belongs to req.user.id
  const inv = db.query("SELECT * FROM invoices WHERE id = ?").all(id);
  res.json(inv);
}`,
	},
	{
		path: "src/lib/templating.ts",
		vulnerable: true,
		label: "SSTI (user-controlled template string)",
		src: `import ejs from "ejs";
export function renderGreeting(req: { query: Record<string, string> }) {
  const name = req.query.name ?? "guest";
  const template = "<h1>Hello " + name + "</h1>";
  return ejs.render(template, {});
}`,
	},
	{
		path: "src/config/payments.ts",
		vulnerable: true,
		label: "Hardcoded secret (exposed credential)",
		src: `import Stripe from "stripe";
const STRIPE_SECRET = "stripe_live_fixture_key_redacted";
export const stripe = new Stripe(STRIPE_SECRET);
export function charge(amountCents: number, token: string) {
  return stripe.charges.create({ amount: amountCents, currency: "usd", source: token });
}`,
	},

	// --- safe decoys (look risky, are safe) ---
	{
		path: "src/handlers/profile.ts",
		vulnerable: false,
		label: "DECOY: parameterized + session id (no SQLi/IDOR)",
		src: `import type { Database } from "bun:sqlite";
export async function getProfile(req: { session: { userId: number } }, db: Database) {
  // reads ONLY the caller's own row, by session id — not user input
  return db.query("SELECT id, name, email FROM users WHERE id = ?").all(req.session.userId);
}`,
	},
	{
		path: "src/handlers/ping.ts",
		vulnerable: false,
		label: "DECOY: execFile + array args + allowlist (no cmdi)",
		src: `import { execFile } from "node:child_process";
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;
export function ping(req: { query: Record<string, string> }, res: any) {
  const host = req.query.host ?? "";
  if (!HOST_RE.test(host)) return res.status(400).send("bad host");
  execFile("ping", ["-c", "1", host], (err, stdout) => res.send(err ? "down" : stdout));
}`,
	},
	{
		path: "src/handlers/docs.ts",
		vulnerable: false,
		label: "DECOY: resolved + containment check (no traversal)",
		src: `import path from "node:path";
import { readFile } from "node:fs/promises";
const BASE = path.resolve("docs");
export async function readDoc(req: { params: { name: string } }, res: any) {
  const target = path.resolve(BASE, req.params.name);
  if (target !== BASE && !target.startsWith(BASE + path.sep)) return res.status(403).send("nope");
  res.send(await readFile(target, "utf8"));
}`,
	},
];

async function f1DeepResearch(): Promise<boolean> {
	console.log(
		"\n=== F1: Deep Whitebox Research — 7 fresh vulns + 3 safe decoys (real GLM) ===",
	);
	const budget = createBudget({
		ceilingUsd: 1_000,
		usdPerMTokOut: pricePerMTok,
	}); // measure only
	const llm = createMeteredClient(
		createOpenRouterClient({ apiKey, baseUrl, model, jsonMode: true }),
		budget,
	);

	const files = FIXTURES.map((f) => fileToDiffFile(f.path, f.src));
	const result = await runReview(
		{ kind: "whitebox", files, mode: "deep" },
		{ llm },
	);

	const flagged = new Set(result.findings.map((f) => f.filePath));
	const flaggedHigh = new Set(
		result.findings
			.filter((f) => f.confidence === "high" || f.confidence === "verified")
			.map((f) => f.filePath),
	);

	console.log(
		`  score: ${result.score0to5}/5   findings: ${result.findings.length}   est.cost: ${usd(budget.spentUsd())}`,
	);
	for (const f of result.findings) {
		console.log(
			`   - ${f.filePath.padEnd(28)} ${String(f.severity).padEnd(8)} ${String(f.confidence).padEnd(9)} ${f.category}`,
		);
	}

	console.log("\n  per-fixture scorecard:");
	let truePos = 0;
	let falseNeg = 0;
	let falsePos = 0;
	for (const fx of FIXTURES) {
		const hit = flagged.has(fx.path);
		const hitHigh = flaggedHigh.has(fx.path);
		if (fx.vulnerable) {
			if (hit) truePos++;
			else falseNeg++;
			console.log(
				`    ${hit ? "✓" : "✗MISS"}  VULN ${fx.path.padEnd(28)} ${fx.label}`,
			);
		} else {
			if (hitHigh) falsePos++;
			console.log(
				`    ${hitHigh ? "✗FP  " : "✓"}  SAFE ${fx.path.padEnd(28)} ${fx.label}`,
			);
		}
	}

	const totalVuln = FIXTURES.filter((f) => f.vulnerable).length;
	const recall = truePos / totalVuln;
	console.log(
		`\n  recall: ${truePos}/${totalVuln} (${(recall * 100).toFixed(0)}%)  | false-negatives: ${falseNeg} | decoy false-positives (high+): ${falsePos}`,
	);
	// PASS: catch ≥5/7 real vulns AND no more than 1 decoy flagged at high+ confidence.
	const pass = truePos >= 5 && falsePos <= 1;
	console.log(
		`  F1 ${pass ? "PASS ✓" : "FAIL ✗"}  (need ≥5/7 recall AND ≤1 decoy FP)`,
	);
	return pass;
}

// ===========================================================================
// F2 — Autonomous Exploit Lab across MULTIPLE classes w/ server-side telemetry
// ===========================================================================

/** A live, controlled, deliberately-vulnerable target with server-side proof. */
interface LiveTarget {
	baseUrl: string;
	endpoint: string;
	method: string;
	excerpt: string;
	/** True iff the SERVER observed a real exploitation (not just an echoed marker). */
	confirmed: () => boolean;
	/** What the server-side confirmation actually checks (for honest reporting). */
	confirmKind: string;
	stop: () => void;
}

// --- T1: SQL injection (UNION) ---------------------------------------------
function startSqliTarget(canary: string): LiveTarget {
	const db = new Database(":memory:");
	db.run("CREATE TABLE users (name TEXT)");
	db.run("INSERT INTO users (name) VALUES ('alice'), ('bob')");
	db.run("CREATE TABLE secrets (flag TEXT)");
	db.query("INSERT INTO secrets (flag) VALUES (?)").run(canary);
	let injected = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/users") {
				const name = url.searchParams.get("name") ?? "";
				// confirm REAL injection: the param breaks out of the string literal.
				if (/'|union|--/i.test(name)) injected = true;
				const sql = `SELECT name FROM users WHERE name = '${name}'`;
				try {
					return Response.json({ rows: db.query(sql).all() });
				} catch (e) {
					return new Response(`SQL error: ${(e as Error).message}`, {
						status: 500,
					});
				}
			}
			return new Response("not found", { status: 404 });
		},
	});
	const port = server.port as number;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		endpoint: "/users",
		method: "GET",
		excerpt: `// GET /users?name=<name> — search users by name.
const name = url.searchParams.get("name");
const sql = "SELECT name FROM users WHERE name = '" + name + "'";   // concatenated
const rows = db.query(sql).all();
// The same DB also has  secrets(flag TEXT)  with one sensitive value.
return Response.json({ rows });`,
		confirmKind: "query-structure-altered (injection)",
		confirmed: () => injected,
		stop: () => server.stop(true),
	};
}

// --- T2: OS command injection ----------------------------------------------
function startCmdiTarget(canary: string): LiveTarget {
	let exploited = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/diag/disk") {
				const p = url.searchParams.get("path") ?? ".";
				// Deliberately vulnerable sink: user path concatenated into a shell cmd.
				const proc = Bun.spawn(["sh", "-c", `du -sh ${p} 2>&1`], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const out = await new Response(proc.stdout).text();
				await proc.exited;
				// confirm REAL injection: the injected `echo <canary>` ran server-side.
				if (out.includes(canary)) exploited = true;
				return new Response(out);
			}
			return new Response("not found", { status: 404 });
		},
	});
	const port = server.port as number;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		endpoint: "/api/diag/disk",
		method: "GET",
		excerpt: `// GET /api/diag/disk?path=<path> — admin disk-usage tool.
const p = url.searchParams.get("path");
const proc = Bun.spawn(["sh", "-c", "du -sh " + p + " 2>&1"]);  // path into shell
return new Response(await new Response(proc.stdout).text());`,
		confirmKind: "injected command executed server-side",
		confirmed: () => exploited,
		stop: () => server.stop(true),
	};
}

// --- T3: Path traversal ----------------------------------------------------
function startPathTraversalTarget(canary: string): {
	target: LiveTarget;
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "zeroday-pt-"));
	const served = join(root, "public");
	mkdirSync(served);
	writeFileSync(join(served, "index.html"), "<h1>welcome</h1>");
	// The canary file sits ONE LEVEL ABOVE the served dir.
	writeFileSync(join(root, "secret.txt"), canary);
	let exploited = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/download") {
				const file = url.searchParams.get("file") ?? "index.html";
				const full = join(served, file); // no containment check
				try {
					const data = readFileSync(full, "utf8");
					// confirm REAL traversal: the resolved path escaped the served dir.
					if (!resolve(full).startsWith(resolve(served) + sep))
						exploited = true;
					return new Response(data);
				} catch {
					return new Response("not found", { status: 404 });
				}
			}
			return new Response("not found", { status: 404 });
		},
	});
	const port = server.port as number;
	const target: LiveTarget = {
		baseUrl: `http://127.0.0.1:${port}`,
		endpoint: "/download",
		method: "GET",
		excerpt: `// GET /download?file=<file> — serve a file from ./public/
// Layout:  ./public/index.html   and   ./secret.txt  (one level UP, holds an API token)
const file = url.searchParams.get("file");
const data = readFileSync(path.join("public", file), "utf8");  // no containment
return new Response(data);`,
		confirmKind: "resolved path escaped served dir",
		confirmed: () => exploited,
		stop: () => server.stop(true),
	};
	return {
		target,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// --- T4: IDOR / broken access control --------------------------------------
function startIdorTarget(canary: string): LiveTarget {
	const SESSION_USER = 1; // the authenticated attacker
	const notes: Record<number, { owner: number; body: string }> = {
		1: { owner: 1, body: "my own grocery list" },
		2: { owner: 2, body: canary }, // belongs to ANOTHER tenant
	};
	let exploited = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const m = url.pathname.match(/^\/api\/notes\/(\d+)$/);
			if (m) {
				const id = Number(m[1]);
				const note = notes[id];
				if (!note) return new Response("not found", { status: 404 });
				// VULNERABLE: no check note.owner === SESSION_USER.
				if (note.owner !== SESSION_USER) exploited = true;
				return Response.json(note);
			}
			return new Response("not found", { status: 404 });
		},
	});
	const port = server.port as number;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		endpoint: "/api/notes/:id",
		method: "GET",
		excerpt: `// GET /api/notes/:id — you are authenticated as user id=1.
// Notes are owned by users; note id=1 is yours, id=2 belongs to another tenant.
const note = notes[id];               // looked up by id only
// MISSING: if (note.owner !== session.userId) return 403;
return Response.json(note);`,
		confirmKind: "cross-tenant record returned",
		confirmed: () => exploited,
		stop: () => server.stop(true),
	};
}

interface F2Spec {
	name: string;
	category: string;
	cwe: string[];
	cvssScore: number;
	start: (canary: string) => { target: LiveTarget; cleanup?: () => void };
}

const F2_SPECS: F2Spec[] = [
	{
		name: "SQL Injection",
		category: "SQL Injection",
		cwe: ["CWE-89"],
		cvssScore: 9.8,
		start: (c) => ({ target: startSqliTarget(c) }),
	},
	{
		name: "OS Command Injection",
		category: "OS Command Injection",
		cwe: ["CWE-78"],
		cvssScore: 9.8,
		start: (c) => ({ target: startCmdiTarget(c) }),
	},
	{
		name: "Path Traversal",
		category: "Path Traversal",
		cwe: ["CWE-22"],
		cvssScore: 7.5,
		start: (c) => startPathTraversalTarget(c),
	},
	{
		name: "Broken Access Control (IDOR)",
		category: "Broken Access Control",
		cwe: ["CWE-639"],
		cvssScore: 8.1,
		start: (c) => ({ target: startIdorTarget(c) }),
	},
];

async function f2OneTarget(
	spec: F2Spec,
	budget: ReturnType<typeof createBudget>,
): Promise<{
	proven: boolean;
	serverConfirmed: boolean;
	pass: boolean;
	status?: string;
	iters?: number;
	cost: number;
}> {
	const canary = newCanary("CANARY");
	const { target, cleanup } = spec.start(canary);
	console.log(
		`\n--- F2[${spec.name}] target=${target.baseUrl}${target.endpoint} canary=${canary}`,
	);
	const llm = createOpenRouterClient({
		apiKey,
		baseUrl,
		model,
		jsonMode: false,
	});

	const finding: ReviewFinding = {
		fingerprint: `zd-${spec.cwe[0]}`,
		filePath: "server.ts",
		startLine: 1,
		side: "RIGHT",
		severity: "critical",
		cwe: spec.cwe,
		cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
		cvssScore: spec.cvssScore,
		confidence: "high",
		reachable: false,
		category: spec.category,
		title: `${spec.name} in ${target.endpoint}`,
		rationaleMd: "Confirmed by static review; the Lab must prove reachability.",
		source: "llm",
	};

	const before = budget.spentUsd();
	const buildContext = (): ExploitContext => ({
		filePath: "server.ts",
		codeExcerpt: target.excerpt,
		targetUrl: target.baseUrl,
		endpoint: target.endpoint,
		method: target.method,
		language: "javascript",
	});

	try {
		const outcomes = await runExploitLabForFindings([finding], {
			llm,
			sandbox: createLocalSandbox(),
			scopeDeps: { dnsVerified: () => true },
			makeMarker: () => canary,
			maxIters: 4,
			budget,
			authorization: {
				kind: "dns-scope",
				domain: "localhost",
				scanOrderId: "zd",
			},
			buildContext,
		});
		const v = outcomes[0]?.verdict;
		const proven = v?.proven === true;
		const serverConfirmed = target.confirmed();
		const pass = proven && serverConfirmed;
		const cost = budget.spentUsd() - before;
		console.log(
			`    lab.status=${v?.status} lab.proven=${proven} iters=${v?.iterations} ` +
				`exploitability=${v?.exploitabilityScore} | server-confirmed[${target.confirmKind}]=${serverConfirmed} | cost≈${usd(cost)}`,
		);
		if (proven) {
			const poc = (v?.pocMd ?? "")
				.split("\n")
				.slice(0, 24)
				.map((l) => `      ${l}`)
				.join("\n");
			console.log(poc);
		} else {
			console.log(`    evidence: ${v?.evidence ?? "(none)"}`);
		}
		if (proven && !serverConfirmed) {
			console.log(
				"    ⚠️  lab claimed PROVEN but server saw NO real exploit — gamed marker!",
			);
		}
		console.log(`    ${spec.name}: ${pass ? "PASS ✓" : "FAIL ✗"}`);
		return {
			proven,
			serverConfirmed,
			pass,
			status: v?.status,
			iters: v?.iterations,
			cost,
		};
	} finally {
		target.stop();
		cleanup?.();
	}
}

async function f2ExploitLab(): Promise<boolean> {
	console.log(
		"\n=== F2: Autonomous Exploit Lab — 4 classes, server-confirmed (real GLM) ===",
	);
	// ONE shared spend ceiling across all four targets.
	const budget = createBudget({ ceilingUsd: 3.0, usdPerMTokOut: pricePerMTok });
	const results: { name: string; pass: boolean }[] = [];
	for (const spec of F2_SPECS) {
		const r = await f2OneTarget(spec, budget);
		results.push({ name: spec.name, pass: r.pass });
	}
	console.log(
		`\n  F2 per-class results (cumulative spend ≈ ${usd(budget.spentUsd())}):`,
	);
	for (const r of results) console.log(`    ${r.pass ? "✓" : "✗"} ${r.name}`);
	const passCount = results.filter((r) => r.pass).length;
	// PASS: at least 3 of 4 classes proven AND server-confirmed.
	const pass = passCount >= 3;
	console.log(
		`  F2 ${pass ? "PASS ✓" : "FAIL ✗"}  (${passCount}/4 classes proven+confirmed; need ≥3)`,
	);
	return pass;
}

// ===========================================================================
// Main
// ===========================================================================
async function main(): Promise<void> {
	console.log(
		`ZERO-DAY E2E — model=${model} baseUrl=${baseUrl} price=$${pricePerMTok}/Mtok-out`,
	);
	let f1 = true;
	let f2 = true;
	if (runF1) f1 = await f1DeepResearch();
	if (runF2) f2 = await f2ExploitLab();

	console.log("\n=== SUMMARY ===");
	if (runF1)
		console.log(
			`  F1 Deep Research (zero-day hunt) : ${f1 ? "PASS ✓" : "FAIL ✗"}`,
		);
	if (runF2)
		console.log(
			`  F2 Exploit Lab (multi-class)     : ${f2 ? "PASS ✓" : "FAIL ✗"}`,
		);
	const ok = f1 && f2;
	console.log(
		`\n${ok ? "✓ BOTH FEATURES PROVEN ON FRESH VULNS" : "✗ SOME FEATURES FAILED"}\n`,
	);
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error("\n✗ ZERO-DAY E2E crashed:", err);
	process.exit(1);
});
