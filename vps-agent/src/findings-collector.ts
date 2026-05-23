/**
 * findings-collector — walks one or more directories of `*.md` files and
 * returns canonical `CollectedFinding[]` that line up exactly with the
 * webhook contract's `findings[]` schema
 * (see `specs/001-backend-v2/contracts/webhook.md`).
 *
 * Two kinds of input markdown:
 *
 * 1. **Structured findings** (Decepticon's verifier output, vps-agent's own
 *    diag dumps) — start with `---\n<yaml>\n---\n` frontmatter carrying
 *    `severity`, `title`, optional `evidence`. Parsed via the original
 *    happy path.
 *
 * 2. **Narrative reports** (Decepticon's recon assistant: `SUMMARY.md`,
 *    `report_<target>.md`) — plain markdown, no frontmatter. Wrapped as
 *    `severity: info` synthetic findings so the operator can read the
 *    pentest narrative directly from the audit/UI instead of losing it
 *    when the compose volume is destroyed.
 *
 * Design notes:
 * - Pure function with injectable `readDir` / `readFile` / `stat` so tests
 *   can run either against on-disk fixtures or an in-memory file map.
 * - Recursive directory walk — Decepticon nests output under
 *   `<workspace>/tensol-<scanId>/{recon,findings,…}/`.
 * - Never throws on a malformed input file — bad files go into `rejected`
 *   with a coarse machine-readable `reason`.
 * - Body cap: 49_000 chars (under server's `FindingSchema.body_md.max=50_000`
 *   with headroom for downstream rewriters).
 */

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

/**
 * Directory-entry shape returned by `readDirRich`. Mirrors the subset of
 * `Dirent` that the walker needs so tests can inject a tiny adapter.
 */
export type DirEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type CollectFindingsOptions = {
  /** Single root (legacy). One of `dir` or `dirs` must be provided. */
  dir?: string;
  /**
   * Multiple roots. Each is walked recursively for `*.md` files. Missing
   * directories are silently skipped (Decepticon may not create the
   * `recon/` subdir on a profile that doesn't invoke recon).
   */
  dirs?: string[];
  /**
   * Body cap for synthetic narrative findings (no frontmatter). Defaults
   * to 49_000 chars to stay safely under the server's
   * `FindingSchema.body_md.max = 50_000` limit.
   */
  bodyCharCap?: number;
  /**
   * Legacy single-level `readdir`. Falls back to a recursive walker that
   * uses `readDirRich` when provided. When tests inject only `readDir`
   * we behave as before (flat scan of a single dir).
   */
  readDir?: (path: string) => Promise<string[]>;
  /**
   * Recursive walker hook. When provided, used in preference to `readDir`.
   * Returns entries with `isDirectory` / `isFile` so the walker can
   * descend without a separate stat call.
   */
  readDirRich?: (path: string) => Promise<DirEntry[]>;
  readFile?: (path: string) => Promise<string>;
};

const SEVERITY_SET = new Set<FindingSeverity>([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

/** Default body cap for synthetic narrative findings. */
const DEFAULT_BODY_CHAR_CAP = 49_000;

/**
 * Frontmatter delimiter must be the literal string `---` on its own line,
 * at the very start of the file. We accept either LF or CRLF line endings
 * so Windows-authored Decepticon outputs don't get rejected.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** First H1 line, used as the title of synthetic narrative findings. */
const FIRST_H1_RE = /^[ \t]*#[ \t]+(.+?)\s*$/m;

function defaultReadDir(path: string): Promise<string[]> {
  return readdir(path);
}

function defaultReadDirRich(path: string): Promise<DirEntry[]> {
  return readdir(path, { withFileTypes: true }).then((dirents) =>
    dirents.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    })),
  );
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

function truncate(body: string, cap: number): string {
  if (body.length <= cap) return body;
  return body.slice(0, cap);
}

/**
 * Wrap a frontmatter-less markdown file as an `info` finding. Title comes
 * from the first H1 in the body, or the filename stem if no H1 exists.
 * Body is truncated to `bodyCharCap` to stay under the server's per-finding
 * `body_md` size limit.
 */
function synthesizeNarrative(
  filename: string,
  content: string,
  bodyCharCap: number,
): CollectedFinding {
  const h1Match = FIRST_H1_RE.exec(content);
  const baseTitle = h1Match?.[1]?.trim();
  const fallbackTitle = basename(filename, ".md") || filename;
  const rawTitle = baseTitle && baseTitle.length > 0 ? baseTitle : fallbackTitle;
  // FindingSchema caps title at 500 chars server-side.
  const title = rawTitle.slice(0, 500);
  const body_md = truncate(content, bodyCharCap);
  return { severity: "info", title, body_md };
}

function parseOne(
  filename: string,
  content: string,
  bodyCharCap: number,
): { ok: true; value: CollectedFinding } | { ok: true; rejected: RejectedFinding } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    // No frontmatter → narrative path (Decepticon recon SUMMARY/report).
    return { ok: true, value: synthesizeNarrative(filename, content, bodyCharCap) };
  }
  const [, frontmatterRaw, bodyRaw] = match;
  if (frontmatterRaw === undefined || bodyRaw === undefined) {
    return { ok: true, value: synthesizeNarrative(filename, content, bodyCharCap) };
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
  const body_md = truncate(bodyRaw.replace(/\n$/, ""), bodyCharCap);

  const finding: CollectedFinding =
    evidenceResult.value === undefined
      ? { severity, title: title.slice(0, 500), body_md }
      : { severity, title: title.slice(0, 500), body_md, evidence: evidenceResult.value };

  return { ok: true, value: finding };
}

/**
 * Recursive walker. Returns a flat list of absolute `.md` file paths under
 * `root`. Missing directories yield an empty list (silent skip) so callers
 * can pass speculative roots like `<workspace>/findings/` that may not
 * exist for a given scan profile.
 */
async function walkMd(
  root: string,
  readDirRich: (path: string) => Promise<DirEntry[]>,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: DirEntry[];
    try {
      entries = await readDirRich(dir);
    } catch {
      // Missing dir or permission error — skip silently.
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        stack.push(full);
      } else if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }
  // Sort for deterministic ordering across runs (important for tests and
  // for stable dedup_key generation downstream).
  return out.sort();
}

/**
 * Flat single-level scan (legacy). Used only when the caller injected
 * `readDir` but no `readDirRich` (test compat path). Matches the old
 * pre-recursive behaviour exactly.
 */
async function flatMd(
  dir: string,
  readDir: (path: string) => Promise<string[]>,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => join(dir, name))
    .sort();
}

export async function collectFindings(
  opts: CollectFindingsOptions
): Promise<CollectionResult> {
  const readFile = opts.readFile ?? defaultReadFile;
  const bodyCharCap = opts.bodyCharCap ?? DEFAULT_BODY_CHAR_CAP;

  // Build the list of root directories from either `dirs` (preferred) or
  // the legacy `dir`. At least one must be supplied.
  const roots: string[] = [];
  if (opts.dirs && opts.dirs.length > 0) roots.push(...opts.dirs);
  if (opts.dir) roots.push(opts.dir);
  if (roots.length === 0) {
    return { findings: [], rejected: [] };
  }

  // Choose walker strategy. Recursive (rich) is preferred — falls back to
  // flat single-level only when the caller injected `readDir` alone (this
  // is the existing test-injection pattern in `findings-collector.test.ts`).
  const useFlat = !opts.readDirRich && !!opts.readDir;
  const readDir = opts.readDir ?? defaultReadDir;
  const readDirRich = opts.readDirRich ?? defaultReadDirRich;

  // Gather all .md paths across all roots, deduped (a path can legitimately
  // appear under multiple roots if roots nest, e.g. workspace + findings).
  const seen = new Set<string>();
  const mdPaths: string[] = [];
  for (const root of roots) {
    const found = useFlat
      ? await flatMd(root, readDir)
      : await walkMd(root, readDirRich);
    for (const p of found) {
      if (!seen.has(p)) {
        seen.add(p);
        mdPaths.push(p);
      }
    }
  }

  const findings: CollectedFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const full of mdPaths) {
    let content: string;
    try {
      content = await readFile(full);
    } catch {
      // Race: file disappeared between walk and read. Skip silently.
      continue;
    }
    // The `file` field in rejected reasons preserves the original basename
    // for log-friendliness (matches pre-recursive behaviour).
    const result = parseOne(basename(full), content, bodyCharCap);
    if ("value" in result) {
      findings.push(result.value);
    } else {
      rejected.push(result.rejected);
    }
  }

  return { findings, rejected };
}
