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

/** Per-field BYTE ceilings — bound request size to protect the indexer + LLM
 *  budget (defense-in-depth against the ReDoS / oversized-input DoS surface).
 *  Enforced as UTF-8 byte length, NOT String.prototype.length (UTF-16 units):
 *  a `.max(N)` char cap would let CJK/emoji payloads reach ~3x the byte budget. */
export const MAX_PATCH_BYTES = 512 * 1024;
export const MAX_CONTENTS_BYTES = 512 * 1024;
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_REVIEW = 600;
/** Aggregate UTF-8 byte ceiling across all files' patch+contents (and a raw
 *  diff). Bounds the SUM so per-field caps × 600 files cannot reach hundreds of
 *  MiB. Sized to the raw-diff ceiling so either input mode caps to the same
 *  total. The Hono `bodyLimit` (mounted in server.ts) rejects oversized bodies
 *  with 413 before buffering; this `.refine` caps the parsed-object path too. */
export const MAX_TOTAL_REVIEW_BYTES = MAX_DIFF_BYTES;

/** Byte-length (UTF-8) refinement: true when `s` is within `n` bytes. */
const withinBytes = (n: number) => (s: string) =>
  Buffer.byteLength(s, "utf8") <= n;

export const ReviewFileSchema = z.object({
  path: z.string().min(1).max(2048),
  status: z.enum(["added", "modified", "removed", "renamed"]).default("modified"),
  patch: z
    .string()
    .refine(withinBytes(MAX_PATCH_BYTES), {
      message: `patch exceeds ${MAX_PATCH_BYTES} bytes`,
    })
    .optional(),
  contents: z
    .string()
    .refine(withinBytes(MAX_CONTENTS_BYTES), {
      message: `contents exceeds ${MAX_CONTENTS_BYTES} bytes`,
    })
    .optional(),
  previous_path: z.string().max(2048).optional(),
});

/** Sum of every file's patch+contents UTF-8 bytes plus a raw diff. */
function totalReviewBytes(b: {
  diff?: string | undefined;
  files?: Array<{ patch?: string | undefined; contents?: string | undefined }> | undefined;
}): number {
  let total = b.diff ? Buffer.byteLength(b.diff, "utf8") : 0;
  for (const f of b.files ?? []) {
    if (f.patch) total += Buffer.byteLength(f.patch, "utf8");
    if (f.contents) total += Buffer.byteLength(f.contents, "utf8");
  }
  return total;
}

export const ReviewApiBodySchema = z
  .object({
    /** "owner/name" repo slug. */
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name"),
    pr: z.number().int().positive().optional(),
    head_sha: z.string().min(1).optional(),
    base_sha: z.string().min(1).optional(),
    /** Raw unified diff (alternative to structured `files`). */
    diff: z
      .string()
      .refine(withinBytes(MAX_DIFF_BYTES), {
        message: `diff exceeds ${MAX_DIFF_BYTES} bytes`,
      })
      .optional(),
    files: z.array(ReviewFileSchema).max(MAX_FILES_PER_REVIEW).optional(),
  })
  .refine((b) => Boolean(b.diff) || (b.files && b.files.length > 0), {
    message: "either `diff` or non-empty `files` is required",
  })
  .refine((b) => totalReviewBytes(b) <= MAX_TOTAL_REVIEW_BYTES, {
    message: `total request payload exceeds ${MAX_TOTAL_REVIEW_BYTES} bytes`,
  });

export type ReviewApiBody = z.infer<typeof ReviewApiBodySchema>;

export const WhiteboxLaunchBodySchema = z.object({
  /** Either an existing connected repo id, or a repo slug ("owner/name").
   *  The clone URL is derived server-side from the slug; a caller-supplied
   *  clone URL (self-hosted / private mirror) is a known follow-up and is NOT
   *  accepted here, so we never validate-then-ignore it. */
  repo_id: z.string().optional(),
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be owner/name")
    .optional(),
  ref: z.string().optional(),
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

/** Minimal shape of a repository entry in installation payloads. */
const GhInstallationRepoSchema = z
  .object({
    id: z.number(),
    full_name: z.string(),
    name: z.string(),
    private: z.boolean().optional(),
  })
  .passthrough();

export const GithubWebhookSchema = z
  .object({
    action: z.string().optional(),
    installation: z
      .object({
        id: z.number(),
        /** Present on `installation` events; carries the account (user/org) that installed the App. */
        account: z
          .object({ login: z.string(), type: z.string().optional() })
          .passthrough()
          .optional(),
        repository_selection: z.enum(["all", "selected"]).optional(),
        /** Repositories listed on initial install (installation.created). */
        repositories: z.array(GhInstallationRepoSchema).optional(),
      })
      .passthrough()
      .optional(),
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
    /** Repos added in an `installation_repositories.added` event. */
    repositories_added: z.array(GhInstallationRepoSchema).optional(),
    /** Repos removed in an `installation_repositories.removed` event. */
    repositories_removed: z.array(GhInstallationRepoSchema).optional(),
  })
  .passthrough();

export type GithubWebhook = z.infer<typeof GithubWebhookSchema>;
