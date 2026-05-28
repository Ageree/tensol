/**
 * 003-whitebox — repository file source for whitebox scans.
 *
 * A whitebox scan reviews a whole repository rather than a PR diff. To reuse
 * the SAME candidate-derivation path as PR review (which keys off added-diff
 * hunks), we represent each repo file as a `DiffFile` whose `patch` marks the
 * entire file as ADDED. `deriveCandidates` then yields one whole-file candidate
 * per file, and any SAST findings layer on top as higher-signal candidates —
 * no engine changes required.
 *
 * The default fetcher shallow-clones over git (Bun.spawn) into a temp dir,
 * walks the tree (skipping vendored/binary paths), and removes the checkout.
 * `spawn` + the temp root are injectable so the wire behaviour is testable, and
 * `FakeRepoFetcher` lets handler tests avoid git entirely.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile } from "./types.ts";

/** Synthesize a unified-diff patch that marks an entire file as added. */
export function fileToAddedDiff(content: string): string {
  const lines = content.split("\n");
  // A trailing newline produces a final empty element; drop it so the hunk
  // length matches the visible line count.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;
  if (n === 0) return "";
  const header = `@@ -0,0 +1,${n} @@`;
  const body = lines.map((l) => `+${l}`).join("\n");
  return `${header}\n${body}`;
}

/** Build a whole-file `DiffFile` (status "added", synthesized full-add patch). */
export function fileToDiffFile(path: string, content: string): DiffFile {
  return { path, status: "added", patch: fileToAddedDiff(content) };
}

export interface RepoFetchArgs {
  /** Clone URL (https). May embed a token, e.g. `https://x-access-token:<t>@github.com/o/r.git`. */
  readonly cloneUrl: string;
  /** Branch or commit ref to check out (default: remote default branch). */
  readonly ref?: string;
  /** Cap the number of files returned (default 400). */
  readonly maxFiles?: number;
  /** Skip files larger than this many bytes (default 256 KiB). */
  readonly maxBytesPerFile?: number;
  /** Only include files with these extensions (no dot). Defaults to source code. */
  readonly includeExtensions?: readonly string[];
}

/**
 * A materialized repository checkout. `files` are always present; `repoDir` is
 * set only when the files live on disk (enables on-disk SAST). The caller MUST
 * call `cleanup()` (in a `finally`) once the scan is done.
 */
export interface RepoCheckout {
  readonly files: DiffFile[];
  readonly repoDir?: string;
  cleanup(): Promise<void> | void;
}

export interface RepoFetcher {
  fetch(args: RepoFetchArgs): Promise<RepoCheckout>;
}

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Source-code extensions worth feeding the reviewer (lowercase, no dot). */
const DEFAULT_EXTENSIONS: readonly string[] = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "scala",
  "php", "c", "h", "cpp", "cc", "hpp", "cs",
  "sol", "sh", "bash", "sql",
  "yaml", "yml", "tf", "hcl", "json", "env",
];

/** Directories never worth walking (vendored deps, VCS, build output). */
const SKIP_DIRS = new Set<string>([
  ".git", "node_modules", "dist", "build", "out", "target", "vendor",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", "coverage",
  ".idea", ".vscode", "bin", "obj",
]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** Recursively collect repo-relative file paths under `root` (bounded). */
function walkFiles(
  root: string,
  include: ReadonlySet<string>,
  maxFiles: number,
): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < maxFiles) {
    const rel = stack.pop() as string;
    const abs = rel === "" ? root : join(root, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.length >= maxFiles) break;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let isDir = false;
      try {
        isDir = statSync(join(abs, name)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(childRel);
      } else if (include.has(extOf(name))) {
        out.push(childRel);
      }
    }
  }
  return out;
}

export interface GitRepoFetcherOpts {
  /** Injectable process spawner (defaults to Bun.spawn). */
  readonly spawn?: (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;
  /** Root dir for temp checkouts (default: OS tmpdir). */
  readonly tmpRoot?: string;
}

async function defaultSpawn(cmd: string[]): Promise<{ exitCode: number; stderr: string }> {
  // Bun.spawn is available in the runtime; typed loosely to avoid a hard dep.
  const proc = (globalThis as { Bun?: { spawn: (c: string[], o: unknown) => unknown } }).Bun?.spawn(
    cmd,
    { stdout: "ignore", stderr: "pipe" },
  ) as { exited: Promise<number>; stderr: ReadableStream } | undefined;
  if (!proc) throw new Error("repo-fetch: Bun.spawn unavailable; inject a spawn impl");
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

/**
 * Production fetcher: `git clone --depth 1` into a temp dir, walk, then remove.
 */
export function createGitRepoFetcher(opts?: GitRepoFetcherOpts): RepoFetcher {
  const spawn = opts?.spawn ?? defaultSpawn;
  const tmpRoot = opts?.tmpRoot ?? tmpdir();

  return {
    async fetch(args): Promise<RepoCheckout> {
      const maxFiles = args.maxFiles ?? DEFAULT_MAX_FILES;
      const maxBytes = args.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
      const include = new Set(args.includeExtensions ?? DEFAULT_EXTENSIONS);
      const dir = mkdtempSync(join(tmpRoot, "tensol-wb-"));
      const cleanup = () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      };
      try {
        const clone = [
          "git", "clone", "--depth", "1", "--single-branch",
          ...(args.ref ? ["--branch", args.ref] : []),
          args.cloneUrl, dir,
        ];
        const res = await spawn(clone);
        if (res.exitCode !== 0) {
          throw new Error(
            `repo-fetch: git clone failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
          );
        }
        const rels = walkFiles(dir, include, maxFiles);
        const files: DiffFile[] = [];
        for (const rel of rels) {
          const abs = join(dir, rel);
          try {
            if (statSync(abs).size > maxBytes) continue;
            const content = readFileSync(abs, "utf8");
            files.push(fileToDiffFile(rel, content));
          } catch {
            // Unreadable/binary file — skip.
          }
        }
        return { files, repoDir: dir, cleanup };
      } catch (err) {
        cleanup();
        throw err;
      }
    },
  };
}

/** In-memory fetcher for tests — returns whole-file DiffFiles from a map. */
export class FakeRepoFetcher implements RepoFetcher {
  readonly calls: RepoFetchArgs[] = [];
  readonly #files: Record<string, string>;

  constructor(files: Record<string, string>) {
    this.#files = { ...files };
  }

  fetch(args: RepoFetchArgs): Promise<RepoCheckout> {
    this.calls.push(args);
    const files = Object.entries(this.#files).map(([path, content]) =>
      fileToDiffFile(path, content),
    );
    // No `repoDir` — in-memory fakes are not on disk, so SAST is skipped.
    return Promise.resolve({ files, cleanup: () => {} });
  }
}
