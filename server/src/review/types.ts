/**
 * 003-whitebox — core domain types for the review engine.
 *
 * Shared by both sub-products (PR Review + Whitebox Pentest), which run the
 * same engine. These are the contracts every leaf module imports; keep them
 * stable. Design rationale: `docs/research/2026-05-29-hacktron-whitebox-dossier.md`
 * §7 and §10.
 *
 * Hard rule encoded in the type system: the LLM emits a *decomposed CVSS
 * vector* (`CvssVector`) + reachability + confidence — it NEVER emits the
 * final severity or numeric score. The deterministic scorer (`score.ts`)
 * derives `cvssScore`/`severity` from the vector. This is the anti
 * reward-hacking property every winning vendor relies on.
 */

export type Severity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export type VerificationStatus = "verified" | "unverified" | "refuted";

export type Confidence = "verified" | "high" | "medium" | "low";

export type ReviewKind = "pr" | "whitebox";

export type FindingSource = "llm" | "sast" | "secrets" | "sca";

export type DiffSide = "LEFT" | "RIGHT";

/**
 * CVSS 3.1 base metric components. The eight required base metrics; the model
 * fills these in (objective metrics like AV/AC are reliably extracted by LLMs;
 * the final numeric score is computed deterministically, never asked for).
 */
export interface CvssVector {
  /** Attack Vector. */
  AV: "N" | "A" | "L" | "P";
  /** Attack Complexity. */
  AC: "L" | "H";
  /** Privileges Required. */
  PR: "N" | "L" | "H";
  /** User Interaction. */
  UI: "N" | "R";
  /** Scope. */
  S: "U" | "C";
  /** Confidentiality impact. */
  C: "N" | "L" | "H";
  /** Integrity impact. */
  I: "N" | "L" | "H";
  /** Availability impact. */
  A: "N" | "L" | "H";
}

/**
 * A raw finding emitted by a SAST/secrets/SCA tool after SARIF normalization.
 * These are CANDIDATES, never verdicts — the LLM judge decides truth.
 */
export interface RawFinding {
  ruleId: string;
  source: FindingSource;
  filePath: string;
  startLine?: number;
  endLine?: number;
  message: string;
  /** Tool-reported severity (advisory only — not trusted for scoring). */
  severity?: Severity;
  cwe?: string[];
  snippet?: string;
}

/** A changed file in the PR/diff (or a whole repo file for whitebox). */
export interface DiffFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  /** Unified-diff hunks for the file (PR review). */
  patch?: string;
  /** Full file contents at head SHA (optional, for deeper context). */
  contents?: string;
  /** Set when status === "renamed". */
  previousPath?: string;
}

/**
 * A location worth investigating, derived from either a SAST hit or a changed
 * diff hunk. Fed to the reviewer one-by-one (focused exploitability question).
 */
export interface Candidate {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  ruleId?: string;
  source: FindingSource;
  /** Why this is a candidate (rule message / "changed code in PR"). */
  hint: string;
  snippet?: string;
  cwe?: string[];
}

/** Token-budgeted context assembled for the LLM (never whole files blindly). */
export interface ContextBundle {
  diffSummary: string;
  files: Array<{ path: string; content: string; reason: string }>;
  /** Symbols referenced by the changed code, ranked by relevance. */
  relatedSymbols: string[];
  /** Rough token estimate of the packed bundle. */
  tokenEstimate: number;
}

/**
 * The LLM's structured verdict for one candidate. Note: NO final severity or
 * numeric score — `rationaleMd` is written BEFORE the classification fields
 * (rationale-before-severity), and the scorer derives severity from `cvss`.
 */
export interface LlmVerdict {
  candidateId?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  isVulnerability: boolean;
  /** Human-readable class, e.g. "SQL Injection". */
  category: string;
  cwe: string[];
  /** The exploit path / why-reachable reasoning — written first. */
  rationaleMd: string;
  reachable: boolean;
  confidence: Confidence;
  cvss: CvssVector;
  pocMd?: string;
  fixPromptMd?: string;
  title: string;
}

/** A final per-finding record after deterministic scoring + fingerprinting. */
export interface ReviewFinding {
  fingerprint: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  side: DiffSide;
  severity: Severity;
  cwe: string[];
  /** Canonical CVSS string, e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H". */
  cvssVector: string;
  cvssScore: number;
  confidence: Confidence;
  reachable: boolean;
  category: string;
  title: string;
  rationaleMd: string;
  pocMd?: string;
  fixPromptMd?: string;
  source: FindingSource;
  verificationStatus?: VerificationStatus;
  reachabilityEvidenceMd?: string;
}

/** The complete result of a review run, ready to persist + post. */
export interface ReviewResult {
  kind: ReviewKind;
  /** Merge-readiness 0-5 (5 = clean). Greptile-style, computed deterministically. */
  score0to5: number;
  summaryMd: string;
  findings: ReviewFinding[];
}
