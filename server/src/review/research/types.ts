/**
 * Deep Whitebox Research — domain types for the OpenHack-ported pipeline.
 *
 * Ported (camelCased + adapted) from Hadrian Security's OpenHack JSON schemas
 * (MIT — see ./prompts/OPENHACK-LICENSE). The pipeline is:
 *
 *   files ──recon(det)──▶ RoutingUnit[] ──routing(LLM)──▶ Scenario[]
 *     ──experts(LLM, fan-out)──▶ ScenarioResult[] ──▶ FindingCandidate[]
 *     ──triage(LLM)──▶ TriageDecision[] ──orchestrator──▶ LlmVerdict[]
 *     ──score.ts(det)──▶ ReviewFinding[]  (EXISTING path reused unchanged)
 *
 * Adaptation vs. upstream OpenHack: experts emit a decomposed `CvssVector`
 * (AV/AC/PR/UI/S/C/I/A) and are FORBIDDEN to emit a numeric score — identical
 * to the existing `reviewer.ts` HARD RULE 4, so the deterministic `score.ts`
 * stays the single source of severity/score (anti reward-hacking).
 */
import type { CvssVector, Confidence } from "../types.ts";

/** The 12 OWASP-root-cause expert agents (== ./prompts/experts/<key>.md basenames). */
export type ExpertKey =
  | "injection"
  | "broken-access-control"
  | "authentication-failures"
  | "cryptographic-failures"
  | "insecure-design"
  | "security-misconfiguration"
  | "sensitive-information-exposure"
  | "software-data-integrity-failures"
  | "software-supply-chain-failures"
  | "unrestricted-resource-consumption"
  | "path-traversal-unrestricted-upload"
  | "memory-buffer-boundary-errors";

export const EXPERT_KEYS: readonly ExpertKey[] = [
  "injection",
  "broken-access-control",
  "authentication-failures",
  "cryptographic-failures",
  "insecure-design",
  "security-misconfiguration",
  "sensitive-information-exposure",
  "software-data-integrity-failures",
  "software-supply-chain-failures",
  "unrestricted-resource-consumption",
  "path-traversal-unrestricted-upload",
  "memory-buffer-boundary-errors",
] as const;

/** Recon classification (from OpenHack `inventory_patterns.py` PATTERNS keys). */
export type RoutingUnitKind =
  | "route" | "sql" | "command" | "file" | "upload" | "ssrf"
  | "secret" | "parser" | "state" | "headers" | "host"
  | "identity" | "object" | "xss";

/** Recon bucket (from OpenHack `DETAILS` keys). */
export type RoutingUnitCategory = "routes" | "inputs" | "sinks" | "exposures";

/** A deterministically-detected point of interest in the source. */
export interface RoutingUnit {
  /** "U001"… (OpenHack scenario.routing_unit_id pattern ^U[0-9]{3,}$). */
  id: string;
  kind: RoutingUnitKind;
  category: RoutingUnitCategory;
  filePath: string;
  line: number;
  snippet: string;
  /** The matched pattern tokens. */
  signals: string[];
}

/** A scoped investigation routed to one expert (OpenHack `scenario`). */
export interface Scenario {
  /** "S001"… (^S[0-9]{3,}$). */
  id: string;
  expert: ExpertKey;
  routingUnitIds: string[];
  targetPaths: string[];
  proofQuestion: string;
  evidenceRequired: string[];
  priority?: "critical" | "high" | "normal" | "low";
}

export interface EvidenceItem {
  path: string;
  line: number | string;
  snippet: string;
  role?: string;
  note: string;
}

export interface ProofObligation {
  id: string;
  status: "proven_safe" | "proven_vulnerable" | "not_applicable" | "needs_context";
  summary: string;
}

/** An expert's verdict on one scenario (OpenHack `scenario-result` + our cvss). */
export interface ScenarioResult {
  scenarioId: string;
  expert: ExpertKey;
  status: "verified" | "candidate" | "rejected" | "needs_context";
  primaryVulnerabilityClass?: string;
  summary: string;
  evidence: EvidenceItem[];
  proofObligations: ProofObligation[];
  cwe: string[];
  /** Decomposed CVSS base vector — NO numeric score (scorer derives it). */
  cvss: CvssVector;
}

/** A scenario result promoted to a triage-pending candidate (OpenHack `finding-candidate`). */
export interface FindingCandidate {
  /** "S001-F001"… (^S[0-9]{3,}-F[0-9]{3,}$). */
  candidateId: string;
  scenarioId: string;
  expert: ExpertKey;
  primaryVulnerabilityClass?: string;
  title: string;
  cwe: string[];
  cvss: CvssVector;
  /** Exploit-path / why-reachable reasoning (written before classification). */
  rationaleMd: string;
  evidence: EvidenceItem[];
  filePath: string;
  startLine?: number;
  endLine?: number;
}

/** The independent triage agent's decision (OpenHack `finding-triage`). */
export interface TriageDecision {
  candidateId: string;
  decision: "accepted" | "downgraded" | "duplicate" | "rejected" | "needs_context";
  /** Mapped to our 4-level Confidence (triage emits high/medium/low; a
   * `verified`-status source result lifts to "verified"). */
  finalConfidence: Confidence;
  severityRationale: string;
  /** Set only when decision === "duplicate". */
  duplicateOf?: string;
}
