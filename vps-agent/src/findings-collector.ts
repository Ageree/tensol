/**
 * findings-collector — walks a directory of `*.md` files written by the
 * Decepticon agent inside `/workspace/findings/`, parses each file's YAML
 * frontmatter + markdown body, and returns canonical `CollectedFinding[]`
 * that line up exactly with the webhook contract's `findings[]` schema
 * (see `specs/001-backend-v2/contracts/webhook.md`).
 *
 * Design notes:
 * - Pure function with injectable `readDir` / `readFile` so tests can run
 *   either against on-disk fixtures or an in-memory file map.
 * - Never throws on a malformed input file — bad files go into `rejected`
 *   with a coarse machine-readable `reason`. The caller (webhook poster
 *   in T071+) can choose what to do with rejections (log, drop, raise).
 * - Severity coercion is lower-case only — we don't try to map random
 *   strings ("CRITICAL!" / "Sev1") onto the enum, because we want the
 *   Decepticon agent's output to be deterministic, not autocorrected.
 */

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type FindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export type CollectedFinding = {
  severity: FindingSeverity;
  title: string;
  body_md: string;
  evidence?: { request?: string; response?: string };
};

export type RejectedFinding = {
  file: string;
  reason:
    | "missing_frontmatter"
    | "invalid_yaml"
    | "missing_title"
    | "invalid_severity"
    | "invalid_evidence";
};

export type CollectionResult = {
  findings: CollectedFinding[];
  rejected: RejectedFinding[];
};

export type CollectFindingsOptions = {
  dir: string;
  readDir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
};

const SEVERITY_SET = new Set<FindingSeverity>([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

/**
 * Frontmatter delimiter must be the literal string `---` on its own line,
 * at the very start of the file. We accept either LF or CRLF line endings
 * so Windows-authored Decepticon outputs don't get rejected.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function defaultReadDir(path: string): Promise<string[]> {
  return readdir(path);
}

function defaultReadFile(path: string): Promise<string> {
  return fsReadFile(path, "utf8");
}

function coerceSeverity(raw: unknown): FindingSeverity | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  return SEVERITY_SET.has(lower as FindingSeverity)
    ? (lower as FindingSeverity)
    : null;
}

function coerceEvidence(
  raw: unknown
): { ok: true; value: CollectedFinding["evidence"] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };

  const obj = raw as Record<string, unknown>;
  const request = obj.request;
  const response = obj.response;

  if (request !== undefined && typeof request !== "string") return { ok: false };
  if (response !== undefined && typeof response !== "string") return { ok: false };

  // Only include keys that were actually provided so callers can distinguish
  // "field absent" from "field present and empty".
  const evidence: { request?: string; response?: string } = {};
  if (typeof request === "string") evidence.request = request;
  if (typeof response === "string") evidence.response = response;

  if (evidence.request === undefined && evidence.response === undefined) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: evidence };
}

function parseOne(
  filename: string,
  content: string
): { ok: true; value: CollectedFinding } | { ok: true; rejected: RejectedFinding } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return {
      ok: true,
      rejected: { file: filename, reason: "missing_frontmatter" },
    };
  }
  const [, frontmatterRaw, bodyRaw] = match;
  if (frontmatterRaw === undefined || bodyRaw === undefined) {
    return {
      ok: true,
      rejected: { file: filename, reason: "missing_frontmatter" },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterRaw);
  } catch {
    return {
      ok: true,
      rejected: { file: filename, reason: "invalid_yaml" },
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: true,
      rejected: { file: filename, reason: "invalid_yaml" },
    };
  }

  const fm = parsed as Record<string, unknown>;

  const severity = coerceSeverity(fm.severity);
  if (severity === null) {
    return {
      ok: true,
      rejected: { file: filename, reason: "invalid_severity" },
    };
  }

  const titleRaw = fm.title;
  const title =
    typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (title.length === 0) {
    return {
      ok: true,
      rejected: { file: filename, reason: "missing_title" },
    };
  }

  const evidenceResult = coerceEvidence(fm.evidence);
  if (!evidenceResult.ok) {
    return {
      ok: true,
      rejected: { file: filename, reason: "invalid_evidence" },
    };
  }

  // Body is preserved verbatim aside from a single trailing newline that's
  // an artefact of frontmatter parsing — never the user's whitespace.
  const body_md = bodyRaw.replace(/\n$/, "");

  const finding: CollectedFinding =
    evidenceResult.value === undefined
      ? { severity, title, body_md }
      : { severity, title, body_md, evidence: evidenceResult.value };

  return { ok: true, value: finding };
}

export async function collectFindings(
  opts: CollectFindingsOptions
): Promise<CollectionResult> {
  const readDir = opts.readDir ?? defaultReadDir;
  const readFile = opts.readFile ?? defaultReadFile;

  const entries = await readDir(opts.dir);
  const mdFiles = entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort();

  const findings: CollectedFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const filename of mdFiles) {
    const full = join(opts.dir, filename);
    const content = await readFile(full);
    const result = parseOne(filename, content);
    if ("value" in result) {
      findings.push(result.value);
    } else {
      rejected.push(result.rejected);
    }
  }

  return { findings, rejected };
}
