/**
 * 003-whitebox — Zod schemas: LLM structured output, the `/v1/review` API,
 * and the GitHub webhook subset.
 *
 * Boundary validation per Constitution IX (every external input validated).
 * The LLM output schema is the contract the reviewer forces the model to fill
 * — `severity`/`cvss_score` are deliberately ABSENT (the model never emits the
 * final number; see `types.ts` rationale).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// LLM structured output
// ---------------------------------------------------------------------------

export const CvssVectorSchema = z.object({
  AV: z.enum(["N", "A", "L", "P"]),
  AC: z.enum(["L", "H"]),
  PR: z.enum(["N", "L", "H"]),
  UI: z.enum(["N", "R"]),
  S: z.enum(["U", "C"]),
  C: z.enum(["N", "L", "H"]),
  I: z.enum(["N", "L", "H"]),
  A: z.enum(["N", "L", "H"]),
});

export const LlmVerdictSchema = z.object({
  candidate_id: z.string().optional(),
  file_path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  is_vulnerability: z.boolean(),
  category: z.string().min(1),
  cwe: z.array(z.string()).default([]),
  // rationale BEFORE the classification fields (key prompt invariant).
  rationale_md: z.string().min(1),
  reachable: z.boolean(),
  confidence: z.enum(["verified", "high", "medium", "low"]),
  cvss: CvssVectorSchema,
  poc_md: z.string().optional(),
  fix_prompt_md: z.string().optional(),
  title: z.string().min(1),
});

export const LlmReviewOutputSchema = z.object({
  summary: z.string().default(""),
  verdicts: z.array(LlmVerdictSchema).default([]),
});

export type LlmReviewOutput = z.infer<typeof LlmReviewOutputSchema>;

// ---------------------------------------------------------------------------
// `/v1/review` API body (used by the tensol-loop client skill)
// ---------------------------------------------------------------------------

/** Per-field byte ceilings — bound request size to protect the indexer + LLM
 *  budget (defense-in-depth against the ReDoS / oversized-input DoS surface). */
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_CONTENTS_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_REVIEW = 600;

export const ReviewFileSchema = z.object({
  path: z.string().min(1).max(2048),
  status: z.enum(["added", "modified", "removed", "renamed"]).default("modified"),
  patch: z.string().max(MAX_PATCH_BYTES).optional(),
  contents: z.string().max(MAX_CONTENTS_BYTES).optional(),
  previous_path: z.string().max(2048).optional(),
});

export const ReviewApiBodySchema = z
  .object({
    /** "owner/name" repo slug. */
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
    pr: z.number().int().positive().optional(),
    head_sha: z.string().min(1).optional(),
    base_sha: z.string().min(1).optional(),
    /** Raw unified diff (alternative to structured `files`). */
    diff: z.string().max(MAX_DIFF_BYTES).optional(),
    files: z.array(ReviewFileSchema).max(MAX_FILES_PER_REVIEW).optional(),
  })
  .refine((b) => Boolean(b.diff) || (b.files && b.files.length > 0), {
    message: "either `diff` or non-empty `files` is required",
  });

export type ReviewApiBody = z.infer<typeof ReviewApiBodySchema>;

export const WhiteboxLaunchBodySchema = z.object({
  /** Either an existing connected repo id, or a repo slug + clone url. */
  repo_id: z.string().optional(),
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name")
    .optional(),
  ref: z.string().optional(),
  clone_url: z.string().url().optional(),
});

export type WhiteboxLaunchBody = z.infer<typeof WhiteboxLaunchBodySchema>;

// ---------------------------------------------------------------------------
// GitHub webhook subset — loose passthrough; we extract only what we route on.
// ---------------------------------------------------------------------------

const GhRepoSchema = z
  .object({
    full_name: z.string(),
    default_branch: z.string().optional(),
    owner: z.object({ login: z.string() }).partial().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const GithubWebhookSchema = z
  .object({
    action: z.string().optional(),
    installation: z.object({ id: z.number() }).passthrough().optional(),
    repository: GhRepoSchema.optional(),
    pull_request: z
      .object({
        number: z.number(),
        head: z.object({ sha: z.string() }).passthrough(),
        base: z.object({ sha: z.string() }).passthrough().optional(),
        draft: z.boolean().optional(),
        user: z.object({ login: z.string(), type: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    issue: z
      .object({
        number: z.number(),
        pull_request: z.object({}).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    comment: z
      .object({
        body: z.string(),
        user: z.object({ login: z.string(), type: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    check_run: z.object({}).passthrough().optional(),
  })
  .passthrough();

export type GithubWebhook = z.infer<typeof GithubWebhookSchema>;
