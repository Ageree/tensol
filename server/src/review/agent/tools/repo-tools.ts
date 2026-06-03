/**
 * 005-whitebox-mdash — repo-scoped agent tools.
 *
 * Whitebox has an on-disk checkout (`repoDir`), not a PR, so it needs different
 * tools than `pr-tools.ts`. Same discipline as pr-tools: a narrow capability
 * interface (trivially fakeable in tests), trust-boundary path validation, and
 * output-size bounding (each result becomes input tokens next round). The tools
 * themselves have no shell/network — they can only do what the injected
 * capabilities allow.
 */
import type { AgentTool } from "../loop.ts";
import type { SastRunner } from "../../sast/runner.ts";
import type { ReachabilityClient } from "../../reachability/joern.ts";
import type { ReviewFinding } from "../../types.ts";
import { readFile as fsRead, readdir, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";

const MAX_RESULT_CHARS = 60_000;
const MAX_GREP_MATCHES = 100;
const MAX_WALK_FILES = 5_000;
const MAX_WALK_DEPTH = 12;
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

function bound(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated at ${MAX_RESULT_CHARS} chars)`;
}

/** Trust-boundary path validator (mirrors pr-tools `unsafePathReason`). */
export function unsafePathReason(path: string): string | null {
  if (!path || typeof path !== "string") return "must be a non-empty string";
  if (/[?#\\]/.test(path)) return 'must not contain "?", "#", or "\\"';
  if (path.startsWith("/")) return "must be repo-relative (no leading /)";
  if (path.split("/").includes("..")) return 'must not contain a ".." segment';
  return null;
}

export interface RepoToolCapabilities {
  readonly repoDir: string;
  readFile(path: string): Promise<string | null>;
  listFiles(dir: string): Promise<string[]>;
  grep(pattern: string, glob?: string): Promise<string[]>;
  readonly sast?: SastRunner;
  readonly reachability?: ReachabilityClient;
}

export function buildRepoAgentTools(caps: RepoToolCapabilities): AgentTool[] {
  const readFile: AgentTool = {
    spec: {
      name: "read_file",
      description:
        "Read the full contents of a repo file. Use this to inspect callers, callees, config, and related modules before deciding whether a finding is exploitable.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: 'Repo-relative path, e.g. "src/db/query.ts".' } },
        required: ["path"],
      },
    },
    run: async (args) => {
      const path = String(args.path ?? "");
      const bad = unsafePathReason(path);
      if (bad) return `ERROR: path ${bad}`;
      const contents = await caps.readFile(path);
      return contents === null ? `(file not found: ${path})` : bound(contents);
    },
  };

  const listFiles: AgentTool = {
    spec: {
      name: "list_files",
      description: "List repo-relative file paths under a directory (default: repo root).",
      parameters: {
        type: "object",
        properties: { dir: { type: "string", description: 'Repo-relative dir, e.g. "src". Empty = root.' } },
      },
    },
    run: async (args) => {
      const dir = String(args.dir ?? "");
      if (dir) {
        const bad = unsafePathReason(dir);
        if (bad) return `ERROR: dir ${bad}`;
      }
      const files = await caps.listFiles(dir);
      return bound(files.join("\n") || "(empty)");
    },
  };

  const grep: AgentTool = {
    spec: {
      name: "grep",
      description: "Search the repo for a regular-expression pattern. Returns up to 100 'path:line: text' matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A JavaScript regular expression." },
          glob: { type: "string", description: 'Optional path glob, e.g. "**/*.ts".' },
        },
        required: ["pattern"],
      },
    },
    run: async (args) => {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return "ERROR: pattern must be a non-empty string";
      try {
        const matches = await caps.grep(pattern, args.glob ? String(args.glob) : undefined);
        return bound(matches.slice(0, MAX_GREP_MATCHES).join("\n") || "(no matches)");
      } catch (e) {
        return `ERROR: grep failed — ${(e as Error).message}`;
      }
    },
  };

  const querySast: AgentTool = {
    spec: {
      name: "query_sast",
      description: "Return static-analysis (SAST) hotspots for the repo, optionally filtered to one file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    run: async (args) => {
      if (!caps.sast) return "(no static-analysis runner available)";
      try {
        const findings = await caps.sast.run({
          repoDir: caps.repoDir,
          ...(args.path ? { files: [String(args.path)] } : {}),
        });
        if (findings.length === 0) return "(no SAST findings)";
        return bound(
          findings.map((f) => `${f.filePath}:${f.startLine ?? "?"} [${f.ruleId}] ${f.message}`).join("\n"),
        );
      } catch (e) {
        return `ERROR: SAST query failed — ${(e as Error).message}`;
      }
    },
  };

  const queryReachability: AgentTool = {
    spec: {
      name: "query_reachability",
      description:
        "Check whether code at file:line is reachable from an entry point (taint/CPG). Returns reachable/unreachable/unknown with evidence.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "number" } },
        required: ["file", "line"],
      },
    },
    run: async (args) => {
      if (!caps.reachability) return "(reachability unknown: no analyzer available)";
      const file = String(args.file ?? "");
      const line = Number(args.line ?? 0);
      const bad = unsafePathReason(file);
      if (bad) return `ERROR: file ${bad}`;
      if (!Number.isInteger(line) || line < 1) {
        return "ERROR: line must be a positive integer";
      }
      try {
        const fingerprint = `probe:${file}:${line}`;
        const probe: ReviewFinding = {
          fingerprint,
          filePath: file,
          startLine: line,
          side: "RIGHT",
          severity: "medium",
          cwe: [],
          cvssVector: "",
          cvssScore: 0,
          confidence: "low",
          reachable: false,
          category: "probe",
          title: "reachability probe",
          rationaleMd: "",
          source: "llm",
        };
        const res = await caps.reachability.analyze({ repoDir: caps.repoDir, findings: [probe] });
        const r = res[fingerprint];
        if (!r) return "(reachability unknown)";
        return `reachable=${r.reachable}${r.evidenceMd ? `\n${bound(r.evidenceMd)}` : ""}`;
      } catch (e) {
        return `ERROR: reachability query failed — ${(e as Error).message}`;
      }
    },
  };

  return [readFile, listFiles, grep, querySast, queryReachability];
}

/** Default fs-backed capabilities over an on-disk checkout. Confines all access to `repoDir`. */
export function createFsRepoCapabilities(
  repoDir: string,
  extra?: { sast?: SastRunner; reachability?: ReachabilityClient },
): RepoToolCapabilities {
  // Canonicalize the root so realpath-based containment compares like-for-like.
  // (On macOS tmpdir is `/var/…` → `/private/var/…`; without this every realpath
  // check would compare a canonical target against a non-canonical root and fail.)
  let root: string;
  try {
    root = realpathSync(resolve(repoDir));
  } catch {
    root = resolve(repoDir);
  }
  const within = (abs: string): boolean => abs === root || abs.startsWith(root + sep);
  const inside = (p: string): string | null => {
    const abs = resolve(root, p);
    return within(abs) ? abs : null;
  };
  // Symlink-safe resolution: a tracked symlink (e.g. `secrets -> /etc/passwd`)
  // has a lexical path inside `root` but a real target OUTSIDE it. Resolve the
  // real path and re-check containment so `fsRead` cannot follow a symlink out of
  // the sandbox. Returns null for nonexistent / broken / escaping paths.
  const realInside = async (p: string): Promise<string | null> => {
    const abs = inside(p);
    if (!abs) return null;
    try {
      const real = await realpath(abs);
      return within(real) ? real : null;
    } catch {
      return null;
    }
  };
  async function walk(dir: string, acc: string[], depth = 0): Promise<void> {
    if (depth > MAX_WALK_DEPTH || acc.length > MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      // Skip symlinks entirely — they can point outside the sandbox (a symlinked
      // dir would otherwise be descended, a symlinked file slurped by grep).
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, acc, depth + 1);
      else acc.push(relative(root, abs));
    }
  }
  return {
    repoDir: root,
    readFile: async (p) => {
      const abs = await realInside(p);
      if (!abs) return null;
      try {
        return await fsRead(abs, "utf8");
      } catch {
        return null;
      }
    },
    listFiles: async (d) => {
      const abs = inside(d || ".");
      if (!abs) return [];
      const acc: string[] = [];
      await walk(abs, acc);
      return acc;
    },
    grep: async (pattern) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return [];
      }
      const all: string[] = [];
      await walk(root, all);
      const out: string[] = [];
      for (const rel of all) {
        if (out.length >= MAX_GREP_MATCHES) break;
        const abs = inside(rel);
        if (!abs) continue;
        let text;
        try {
          text = await fsRead(abs, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (out.length >= MAX_GREP_MATCHES) break;
          if (re.test(lines[i]!)) out.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      }
      return out;
    },
    ...(extra?.sast ? { sast: extra.sast } : {}),
    ...(extra?.reachability ? { reachability: extra.reachability } : {}),
  };
}
