/**
 * P2 — agent tools for PR Review.
 *
 * These adapt the GitHub capabilities the reviewer already has (`getFileContents`,
 * `getPullRequestFiles`) into {@link AgentTool}s the gpt-5.5 agent loop can call
 * to gather context on demand — reading whole files beyond the diff and
 * inspecting hunks — BEFORE it commits to a verdict. The fixed-prompt path packs
 * a fixed context bundle up front; the agentic path lets the model pull exactly
 * the context a given finding needs (callers, config, related modules).
 *
 * Each tool depends only on a NARROW capability interface (structurally
 * satisfied by the real `GitHubClient`) so tests inject a trivial fake. Tools
 * validate their own args and bound their output size — a single tool result is
 * fed back to the model as INPUT tokens, so an unbounded file would blow the
 * budget. They never throw for an expected miss (file-not-found is a normal
 * result the model should see), reserving thrown errors for the loop to convert.
 */
import type { AgentTool } from "../loop.ts";
import type { DiffFile } from "../../types.ts";

/** The narrow GitHub surface the PR tools need (a subset of `GitHubClient`). */
export interface PrToolGitHub {
  getFileContents(a: {
    owner: string;
    name: string;
    path: string;
    ref: string;
    installationId?: string;
  }): Promise<string | null>;
  getPullRequestFiles(a: {
    owner: string;
    name: string;
    pr: number;
    installationId?: string;
  }): Promise<DiffFile[]>;
}

/** The PR the tools are bound to (resolved once; the model can't change it). */
export interface PrToolTarget {
  owner: string;
  name: string;
  pr: number;
  /** Head SHA to read file contents at (pinned — not attacker-chosen). */
  ref: string;
  installationId?: string;
}

/**
 * Per-call output cap. A tool result becomes INPUT tokens on the next round, so
 * one giant file must not dominate the loop's budget. ~60k chars ≈ 15k tokens.
 */
const MAX_RESULT_CHARS = 60_000;

/** Truncate a tool result with an explicit marker (never silently). */
function bound(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated at ${MAX_RESULT_CHARS} chars — narrow your request)`
    : text;
}

/** Spread the optional installationId only when present (exactOptional-safe). */
function withInstall<T extends object>(target: PrToolTarget, base: T): T & { installationId?: string } {
  return target.installationId
    ? { ...base, installationId: target.installationId }
    : base;
}

/**
 * Reject a model-supplied file path that could escape the repo-relative space or
 * tamper with the request URL. The `ref` is PINNED server-side to the PR head
 * SHA, but the path is interpolated into the GitHub contents URL — a `?`/`#`
 * could smuggle a second `?ref=` (query-injection) and unpin the ref, and `..`
 * / a leading `/` could try to traverse. The model is attacker-influenceable
 * (it reviews untrusted PR code), so validate-and-reject at this trust boundary.
 * Returns an error string to feed back to the model, or null when the path is
 * clean. (We reject rather than URL-encode the whole path because the contents
 * API needs the literal `/` separators.)
 */
function unsafePathReason(path: string): string | null {
  if (/[?#\\]/.test(path)) return 'must not contain "?", "#", or "\\"';
  if (path.startsWith("/")) return "must be repo-relative (no leading /)";
  if (path.split("/").includes("..")) return 'must not contain a ".." segment';
  return null;
}

/** `read_file` — fetch a whole file at the PR head commit. */
export function makeReadFileTool(gh: PrToolGitHub, target: PrToolTarget): AgentTool {
  return {
    spec: {
      name: "read_file",
      description:
        "Read the full contents of a file at the pull request's head commit. " +
        "Use this to see code beyond the diff hunks — callers, callees, config, " +
        "related modules — before deciding whether a finding is exploitable.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'Repository-relative file path, e.g. "src/db/query.ts".',
          },
        },
        required: ["path"],
      },
    },
    async run(args) {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return 'ERROR: read_file requires a non-empty "path" string argument.';
      const unsafe = unsafePathReason(path);
      if (unsafe) return `ERROR: read_file "path" ${unsafe}. Got: ${path}`;
      const contents = await gh.getFileContents(
        withInstall(target, { owner: target.owner, name: target.name, path, ref: target.ref }),
      );
      if (contents == null) return `(file not found: ${path} @ ${target.ref})`;
      return bound(contents);
    },
  };
}

/** `get_pr_diff` — return the unified-diff hunks of the PR (optionally one file). */
export function makeGetPrDiffTool(gh: PrToolGitHub, target: PrToolTarget): AgentTool {
  return {
    spec: {
      name: "get_pr_diff",
      description:
        "Return the unified-diff hunks of the pull request. Pass an optional " +
        '"path" to limit to one changed file. Use this to see exactly what changed.',
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional: limit the diff to this one file path.",
          },
        },
      },
    },
    async run(args) {
      const files = await gh.getPullRequestFiles(
        withInstall(target, { owner: target.owner, name: target.name, pr: target.pr }),
      );
      const filter =
        typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
      const selected = filter ? files.filter((f) => f.path === filter) : files;
      if (selected.length === 0) {
        return filter ? `(no changed file at ${filter})` : "(no changed files in this PR)";
      }
      const rendered = selected
        .map(
          (f) =>
            `### ${f.path} (${f.status})\n${
              f.patch ?? "(no textual diff — binary or too large)"
            }`,
        )
        .join("\n\n");
      return bound(rendered);
    },
  };
}

/** Build the standard PR Review agent toolset. */
export function buildPrAgentTools(gh: PrToolGitHub, target: PrToolTarget): AgentTool[] {
  return [makeReadFileTool(gh, target), makeGetPrDiffTool(gh, target)];
}
