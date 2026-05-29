/**
 * 003-whitebox — candidate derivation.
 *
 * Turns the two candidate sources into a unified `Candidate[]` the reviewer
 * investigates one-by-one:
 *   1. SAST/secrets/SCA `RawFinding`s (post-SARIF) — high-signal locations.
 *   2. Changed diff hunks — so the LLM reviews newly-introduced code even when
 *      no rule fired (Hacktron's "exploitability not syntax" core; many real
 *      bugs are logic/authz flaws no pattern rule catches).
 *
 * Pure + deterministic: candidate ids are derived from (filePath, line, source)
 * — no clocks/RNG — so re-runs over the same diff yield identical ids.
 */
import type { Candidate, DiffFile, RawFinding } from "./types.ts";

/** A parsed added-code hunk from a unified diff. */
export interface DiffHunk {
  /** 1-based line number in the NEW file where the hunk's added run starts. */
  newStart: number;
  endLine: number;
  /** The added (`+`) lines, concatenated (without the leading `+`). */
  snippet: string;
}

const HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse a unified-diff `patch` into hunks of consecutive ADDED lines, each
 * carrying its new-file start line. Context/removed lines advance the new-file
 * cursor appropriately but are not part of the snippet.
 */
export function parseAddedHunks(patch: string | undefined): DiffHunk[] {
  if (!patch) return [];
  const out: DiffHunk[] = [];
  const lines = patch.split("\n");
  let newLine = 0;
  let run: { start: number; texts: string[] } | null = null;

  const flush = () => {
    if (run && run.texts.length > 0) {
      out.push({
        newStart: run.start,
        endLine: run.start + run.texts.length - 1,
        snippet: run.texts.join("\n"),
      });
    }
    run = null;
  };

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      newLine = Number(header[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!run) run = { start: newLine, texts: [] };
      run.texts.push(line.slice(1));
      newLine += 1;
      continue;
    }
    // Removed line ("-"): does not advance the new-file cursor; ends a run.
    if (line.startsWith("-") && !line.startsWith("---")) {
      flush();
      continue;
    }
    // Context line (" ") or "\ No newline": advances cursor, ends run.
    flush();
    if (!line.startsWith("\\")) newLine += 1;
  }
  flush();
  return out;
}

/**
 * Split a multi-file unified diff (`git diff` output) into per-file
 * `DiffFile`s. Each `diff --git a/<old> b/<new>` block becomes one file; the
 * `patch` is the slice from the first `@@` hunk header onward (the part
 * `parseAddedHunks` understands). Files with no hunk (pure rename/mode change)
 * are still emitted so the caller sees the change, just with an empty patch.
 */
export function splitUnifiedDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const out: DiffFile[] = [];

  let header: string[] = [];
  let body: string[] = [];
  let inBlock = false;

  const flush = () => {
    if (!inBlock) return;
    const joined = [...header, ...body].join("\n");
    const pathMatch =
      /^\+\+\+ b\/(.+)$/m.exec(joined) ??
      /^diff --git a\/.+ b\/(.+)$/m.exec(joined);
    const newPath = pathMatch?.[1]?.trim();
    if (newPath && newPath !== "/dev/null") {
      const isNew = /^new file mode/m.test(joined);
      const isDeleted = /^deleted file mode/m.test(joined);
      const isRenamed = /^rename to /m.test(joined);
      const status: DiffFile["status"] = isDeleted
        ? "removed"
        : isNew
          ? "added"
          : isRenamed
            ? "renamed"
            : "modified";
      const patch = body.length > 0 ? body.join("\n") : undefined;
      out.push({
        path: newPath,
        status,
        ...(patch !== undefined ? { patch } : {}),
      });
    }
    header = [];
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      inBlock = true;
      header = [line];
      body = [];
      continue;
    }
    if (!inBlock) continue;
    if (line.startsWith("@@") || body.length > 0) {
      body.push(line);
    } else {
      header.push(line);
    }
  }
  flush();
  return out;
}

/** Map a SAST `RawFinding` to a `Candidate`. */
function fromRawFinding(f: RawFinding, index: number): Candidate {
  return {
    id: `sast:${f.source}:${f.filePath}:${f.startLine ?? 0}:${index}`,
    filePath: f.filePath,
    ...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
    ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
    ruleId: f.ruleId,
    source: f.source,
    hint: f.message || `${f.source} rule ${f.ruleId}`,
    ...(f.snippet !== undefined ? { snippet: f.snippet } : {}),
    ...(f.cwe !== undefined ? { cwe: f.cwe } : {}),
  };
}

/**
 * Derive candidates from changed files + raw findings.
 *
 * @param maxDiffCandidatesPerFile cap added-hunk candidates per file so a giant
 *   diff doesn't explode the candidate set (default 8). Removed/renamed-only
 *   files contribute no diff candidates.
 */
export function deriveCandidates(args: {
  files: DiffFile[];
  rawFindings?: RawFinding[];
  maxDiffCandidatesPerFile?: number;
}): Candidate[] {
  const { files } = args;
  const rawFindings = args.rawFindings ?? [];
  const cap = args.maxDiffCandidatesPerFile ?? 8;
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const push = (c: Candidate) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };

  // 1. SAST candidates first (highest signal).
  rawFindings.forEach((f, i) => push(fromRawFinding(f, i)));

  // 2. Changed-code candidates from added hunks.
  for (const file of files) {
    if (file.status === "removed") continue;
    const hunks = parseAddedHunks(file.patch);
    hunks.slice(0, cap).forEach((h, i) => {
      push({
        id: `diff:${file.path}:${h.newStart}:${i}`,
        filePath: file.path,
        startLine: h.newStart,
        endLine: h.endLine,
        source: "llm",
        hint: "changed code in PR",
        snippet: h.snippet,
      });
    });
  }

  return out;
}
