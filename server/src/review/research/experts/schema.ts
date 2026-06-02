/**
 * Deep Whitebox Research — Zod schema for an expert agent's structured output.
 *
 * Mirrors `research/types.ts` `ScenarioResult`, with two adaptations the wire
 * contract demands:
 *  1. The model emits a *decomposed* CVSS 3.1 base vector (AV/AC/PR/UI/S/C/I/A)
 *     — NEVER a numeric severity or score (anti reward-hacking; the scorer
 *     derives those downstream, per the dossier HARD RULE).
 *  2. Wire fields are snake_case (`scenario_id`, `proof_obligations`,
 *     `primary_vulnerability_class`); this schema `.transform`s them into the
 *     camelCase `ScenarioResult` domain shape so callers consume one shape.
 *
 * Boundary validation per Constitution IX: every external (LLM) input is
 * validated here before it reaches the domain. On any parse/validate failure
 * the caller (see `index.ts`) returns a safe `rejected` result — this schema
 * never decides control flow by throwing.
 */
import { z } from "zod";
import { CvssVectorSchema } from "../../schemas.ts";
import { EXPERT_KEYS } from "../types.ts";
import type { ScenarioResult } from "../types.ts";

/** The expert keys as a Zod enum (single source: `EXPERT_KEYS`). */
const ExpertKeySchema = z.enum(
  EXPERT_KEYS as unknown as [string, ...string[]],
);

/** One evidence item — `line` is a number or a string (e.g. "1-4" ranges). */
const EvidenceItemSchema = z.object({
  path: z.string().min(1),
  line: z.union([z.number(), z.string()]),
  snippet: z.string().default(""),
  role: z.string().optional(),
  note: z.string().default(""),
});

/** One proof obligation with its proof status. */
const ProofObligationSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "proven_safe",
    "proven_vulnerable",
    "not_applicable",
    "needs_context",
  ]),
  summary: z.string().default(""),
});

/**
 * The raw snake_case wire shape an expert emits. Optional collections default
 * to `[]` so a terse model response still validates.
 */
const ScenarioResultWireSchema = z.object({
  scenario_id: z.string().min(1),
  expert: ExpertKeySchema,
  status: z.enum(["verified", "candidate", "rejected", "needs_context"]),
  primary_vulnerability_class: z.string().optional(),
  summary: z.string().default(""),
  evidence: z.array(EvidenceItemSchema).default([]),
  proof_obligations: z.array(ProofObligationSchema).default([]),
  cwe: z.array(z.string()).default([]),
  cvss: CvssVectorSchema,
});

/**
 * Validate an expert's structured output and transform it into the camelCase
 * `ScenarioResult` domain type. Optional `primary_vulnerability_class` is
 * OMITTED (not set to `undefined`) so the result satisfies
 * `exactOptionalPropertyTypes`.
 */
export const ScenarioResultSchema: z.ZodType<ScenarioResult, z.ZodTypeDef, unknown> =
  ScenarioResultWireSchema.transform((w): ScenarioResult => {
    const base: ScenarioResult = {
      scenarioId: w.scenario_id,
      expert: w.expert as ScenarioResult["expert"],
      status: w.status,
      summary: w.summary,
      evidence: w.evidence.map((e) => {
        const item: ScenarioResult["evidence"][number] = {
          path: e.path,
          line: e.line,
          snippet: e.snippet,
          note: e.note,
        };
        return e.role !== undefined ? { ...item, role: e.role } : item;
      }),
      proofObligations: w.proof_obligations.map((p) => ({
        id: p.id,
        status: p.status,
        summary: p.summary,
      })),
      cwe: w.cwe,
      cvss: w.cvss,
    };
    return w.primary_vulnerability_class !== undefined
      ? { ...base, primaryVulnerabilityClass: w.primary_vulnerability_class }
      : base;
  });
