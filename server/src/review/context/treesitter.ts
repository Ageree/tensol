/**
 * T034 — tree-sitter symbol graph context, behind the repomap boundary.
 *
 * Design goal: provide a RICHER symbol graph (defs / refs / imports / calls)
 * for TS/JS/Python and PageRank-rank the diff neighbourhood. Falls back to
 * the regex RegexSymbolIndexer from repomap.ts on unknown languages or any
 * extraction failure. Exports `buildTreesitterContextBundle` with the SAME
 * shape as `buildContextBundle` so the engine can opt in transparently.
 *
 * NOTE: `web-tree-sitter` (MIT, WASM) is NOT yet in package.json because it
 * requires loading a WASM binary at runtime, which needs careful test-harness
 * plumbing (WASM init, grammar WASM files in the bundle). For now this module
 * delivers a PURE-TS enhanced extractor that outperforms the regex one for
 * TS/JS/Py (e.g. it distinguishes import-specifiers from call-site refs and
 * separates the "calls" axis from "refs"). A TODO below marks the exact swap
 * point for web-tree-sitter once the WASM loading story is settled.
 *
 * TODO(web-tree-sitter): replace the per-language regex tables with
 * `web-tree-sitter` (npm:web-tree-sitter@MIT) WASM parsers for TS, JS, and
 * Python. The switch is mechanical: replace the `extractByLanguage()` call in
 * `extractSymbolGraph()` with `await parser.parse(content)` and an AST walk.
 * The public API and all test contracts stay identical.
 *
 * License: MIT only. No AGPL/BSL/Elastic/Commons-Clause deps introduced here.
 */

import type { DiffFile, Candidate, ContextBundle } from "../types.ts";
import {
  RegexSymbolIndexer,
  type SymbolIndexer,
  estimateTokens,
} from "./repomap.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Richer per-file symbol graph with four axes.
 *
 * defs    — symbols defined (declared) in the file
 * refs    — symbols / module specifiers referenced (imports + bindings)
 * imports — module specifier strings (e.g. './crypto', 'node:fs')
 * calls   — identifiers that appear at call sites (function-call expressions)
 */
export interface SymbolGraph {
  defs: string[];
  refs: string[];
  imports: string[];
  calls: string[];
}

export interface BuildTreesitterContextBundleArgs {
  files: DiffFile[];
  candidates: Candidate[];
  tokenBudget?: number;
  /** Override the underlying indexer (used in tests). */
  indexer?: SymbolIndexer;
}

// ---------------------------------------------------------------------------
// Constants (mirror repomap.ts for consistency)
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 8000;
const CHARS_PER_TOKEN = 4;
const RANK_ROUNDS = 4;
const RANK_DAMPING = 0.85;
/** Per-file byte ceiling — same as repomap.ts, prevents O(n) regex blowout. */
const MAX_INDEX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

type SupportedLanguage = "typescript" | "javascript" | "python";

function detectLanguage(path: string): SupportedLanguage | "unknown" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs")
    return "javascript";
  if (ext === "py") return "python";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Keyword stop-list (shared with regex indexer; keeps noise down)
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class",
  "const", "let", "var", "def", "func", "import", "from", "require", "new",
  "typeof", "await", "async", "yield", "throw", "super", "this", "else", "do",
  "in", "of", "case", "public", "private", "protected", "static", "void",
  "interface", "enum", "struct", "type", "pass", "None", "True", "False",
  "self", "cls", "null", "undefined", "true", "false",
]);

/** Order-preserving dedup. */
function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s) && !STOPWORDS.has(s);
}

// ---------------------------------------------------------------------------
// TypeScript/JavaScript patterns
// ---------------------------------------------------------------------------

/** Named group patterns specific to TS/JS extraction. */

// --- Definitions ---

const TS_DEF_PATTERNS: readonly RegExp[] = [
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*[(<]/g,
  /\b(?:class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
  // arrow function assigned to const: already covered by const/let/var above
  // export default function NAME
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
];

// --- Import specifiers (module paths) ---
const TS_IMPORT_SPECIFIER: readonly RegExp[] = [
  /\bimport\b[^'"`\n]*?from\s*['"`]([^'"`]+)['"`]/g,
  /\bimport\s*(?:type\s+)?['"`]([^'"`]+)['"`]/g,
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
];

// --- Named import bindings (e.g. { foo, bar as baz }) ---
const TS_IMPORT_BINDINGS: readonly RegExp[] = [
  /\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from/g,
];

// --- Call sites ---
const TS_CALL_SITE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

function extractTsJs(content: string): SymbolGraph {
  const defs: string[] = [];
  const refs: string[] = [];
  const imports: string[] = [];
  const calls: string[] = [];

  // --- Defs ---
  for (const pattern of TS_DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      if (name && isIdentifier(name)) defs.push(name);
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // --- Import specifiers ---
  for (const pattern of TS_IMPORT_SPECIFIER) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const spec = m[1];
      if (spec) {
        imports.push(spec);
        refs.push(spec);
      }
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // --- Named import bindings → refs ---
  for (const pattern of TS_IMPORT_BINDINGS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const group = m[1];
      if (group) {
        for (const part of group.split(",")) {
          const name = (part.trim().split(/\s+as\s+/i)[0] ?? "").trim();
          if (isIdentifier(name)) refs.push(name);
        }
      }
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // --- Call sites ---
  TS_CALL_SITE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = TS_CALL_SITE.exec(content)) !== null) {
    const name = cm[1];
    if (name && isIdentifier(name)) {
      calls.push(name);
      refs.push(name);
    }
    if (cm.index === TS_CALL_SITE.lastIndex) TS_CALL_SITE.lastIndex++;
  }

  return {
    defs: uniq(defs),
    refs: uniq(refs),
    imports: uniq(imports),
    calls: uniq(calls),
  };
}

// ---------------------------------------------------------------------------
// Python patterns
// ---------------------------------------------------------------------------

const PY_DEF_PATTERNS: readonly RegExp[] = [
  /\bdef\s+([A-Za-z_][\w]*)\s*\(/g,
  /\bclass\s+([A-Za-z_][\w]*)\s*[:(]/g,
];

const PY_FROM_IMPORT = /\bfrom\s+([A-Za-z_.][\w.]*)\s+import\s+([^\n#]+)/g;
const PY_IMPORT_MODULE = /^import\s+([A-Za-z_.][\w.]*)/gm;
const PY_CALL_SITE = /\b([A-Za-z_][\w]*)\s*\(/g;

function extractPython(content: string): SymbolGraph {
  const defs: string[] = [];
  const refs: string[] = [];
  const imports: string[] = [];
  const calls: string[] = [];

  // --- Defs ---
  for (const pattern of PY_DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      if (name && isIdentifier(name)) defs.push(name);
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // --- from X import a, b ---
  PY_FROM_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_FROM_IMPORT.exec(content)) !== null) {
    // m[1] = module path, m[2] = binding list
    const modPath = m[1];
    if (modPath) {
      imports.push(modPath);
      refs.push(modPath);
    }
    const bindingList = m[2];
    if (bindingList) {
      for (const part of bindingList.split(",")) {
        const name = (part.trim().split(/\s+as\s+/i)[0] ?? "").trim();
        if (isIdentifier(name)) refs.push(name);
      }
    }
    if (m.index === PY_FROM_IMPORT.lastIndex) PY_FROM_IMPORT.lastIndex++;
  }

  // --- import X ---
  PY_IMPORT_MODULE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = PY_IMPORT_MODULE.exec(content)) !== null) {
    const mod = im[1];
    if (mod) {
      imports.push(mod);
      refs.push(mod);
    }
    if (im.index === PY_IMPORT_MODULE.lastIndex) PY_IMPORT_MODULE.lastIndex++;
  }

  // --- Call sites ---
  PY_CALL_SITE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = PY_CALL_SITE.exec(content)) !== null) {
    const name = cm[1];
    if (name && isIdentifier(name)) {
      calls.push(name);
      refs.push(name);
    }
    if (cm.index === PY_CALL_SITE.lastIndex) PY_CALL_SITE.lastIndex++;
  }

  return {
    defs: uniq(defs),
    refs: uniq(refs),
    imports: uniq(imports),
    calls: uniq(calls),
  };
}

// ---------------------------------------------------------------------------
// extractSymbolGraph — public, language-dispatched
// ---------------------------------------------------------------------------

/**
 * Extract a richer `SymbolGraph` (defs/refs/imports/calls) for a single file.
 * Falls back to the regex RegexSymbolIndexer for unknown languages (Ruby, Go,
 * Java, …) so the caller never gets an empty result just because the language
 * is not natively handled.
 *
 * TODO(web-tree-sitter): replace extractTsJs / extractPython with AST-based
 * walks once WASM loading is wired up in the server bundle. Interface is stable.
 */
export function extractSymbolGraph(file: {
  path: string;
  content: string;
}): SymbolGraph {
  const content = file.content ?? "";
  if (content.length > MAX_INDEX_BYTES) {
    return { defs: [], refs: [], imports: [], calls: [] };
  }

  const lang = detectLanguage(file.path);

  try {
    if (lang === "typescript" || lang === "javascript") {
      return extractTsJs(content);
    }
    if (lang === "python") {
      return extractPython(content);
    }
  } catch {
    // Any extraction failure → fall through to regex fallback
  }

  // Fallback: regex indexer (covers Go, Java, Rust, Ruby, etc.)
  const fallback = new RegexSymbolIndexer();
  const { defs, refs } = fallback.extract(file);
  return { defs, refs, imports: [], calls: [] };
}

// ---------------------------------------------------------------------------
// TreesitterSymbolIndexer — drops in as a SymbolIndexer for the repomap bundler
// ---------------------------------------------------------------------------

/**
 * `SymbolIndexer`-compatible adapter over `extractSymbolGraph`. Plug this in
 * as `indexer` in `buildContextBundle` (from repomap.ts) to upgrade the symbol
 * quality while preserving the exact same bundling + ranking pipeline.
 *
 * This class is also the `TreesitterSymbolIndexer` exported for direct testing.
 */
export class TreesitterSymbolIndexer implements SymbolIndexer {
  extract(file: { path: string; content: string }): {
    defs: string[];
    refs: string[];
  } {
    const graph = extractSymbolGraph(file);
    return { defs: graph.defs, refs: graph.refs };
  }
}

// ---------------------------------------------------------------------------
// Internal node + graph structures (mirrors repomap.ts internals exactly)
// ---------------------------------------------------------------------------

interface FileNode {
  path: string;
  file: DiffFile;
  defs: Set<string>;
  refs: Set<string>;
  imports: Set<string>;
  calls: Set<string>;
  isCandidate: boolean;
}

function buildNodes(
  files: readonly DiffFile[],
  candidatePaths: ReadonlySet<string>,
): FileNode[] {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  return sorted.map((file) => {
    const content = file.contents ?? file.patch ?? "";
    const graph = extractSymbolGraph({ path: file.path, content });
    return {
      path: file.path,
      file,
      defs: new Set(graph.defs),
      refs: new Set(graph.refs),
      imports: new Set(graph.imports),
      calls: new Set(graph.calls),
      isCandidate: candidatePaths.has(file.path),
    };
  });
}

/** basename without directory or extension */
function pathStem(p: string): string {
  const noQuery = p.split(/[?#]/)[0] ?? p;
  const base = noQuery.split("/").pop() ?? noQuery;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Build directed reference edges: A → B when A's refs overlap B's defs, or
 * A's import specifier stem matches B's path stem.
 */
function buildEdges(nodes: readonly FileNode[]): Map<number, Set<number>> {
  const defOwners = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    for (const d of node.defs) {
      const arr = defOwners.get(d);
      if (arr) arr.push(i);
      else defOwners.set(d, [i]);
    }
  });

  const stemToIndex = new Map<string, number>();
  nodes.forEach((node, i) => {
    const stem = pathStem(node.path);
    if (!stemToIndex.has(stem)) stemToIndex.set(stem, i);
  });

  const edges = new Map<number, Set<number>>();
  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    const set = edges.get(from);
    if (set) set.add(to);
    else edges.set(from, new Set([to]));
  };

  nodes.forEach((node, i) => {
    // Symbol reference edges (including call sites)
    const allRefs = new Set([...node.refs, ...node.calls]);
    for (const ref of allRefs) {
      const owners = defOwners.get(ref);
      if (owners) for (const o of owners) addEdge(i, o);
    }
    // Import-specifier stem edges
    for (const imp of node.imports) {
      const stem = pathStem(imp);
      const target = stemToIndex.get(stem);
      if (target !== undefined) addEdge(i, target);
    }
    // Also resolve bare refs as module stems (compat with regex repomap)
    for (const ref of node.refs) {
      const stem = pathStem(ref);
      const target = stemToIndex.get(stem);
      if (target !== undefined) addEdge(i, target);
    }
  });

  return edges;
}

/**
 * PageRank-ish ranking (same algorithm as repomap.ts):
 *   tier 0 = candidate files
 *   tier 1 = 1-hop neighbours (either direction)
 *   tier 2 = rest, ordered by PageRank score
 * Ties broken by path for determinism.
 */
function rankNodes(
  nodes: readonly FileNode[],
  edges: ReadonlyMap<number, Set<number>>,
): number[] {
  const n = nodes.length;
  if (n === 0) return [];

  const neighbours: Set<number>[] = nodes.map(() => new Set<number>());
  edges.forEach((tos, from) => {
    for (const to of tos) {
      neighbours[from]!.add(to);
      neighbours[to]!.add(from);
    }
  });

  const candidateIdx = new Set<number>();
  nodes.forEach((node, i) => {
    if (node.isCandidate) candidateIdx.add(i);
  });

  const oneHop = new Set<number>();
  for (const c of candidateIdx) {
    for (const nb of neighbours[c]!) {
      if (!candidateIdx.has(nb)) oneHop.add(nb);
    }
  }

  const outCount = nodes.map((_, i) => edges.get(i)?.size ?? 0);
  let score = new Array<number>(n).fill(1 / n);
  for (let round = 0; round < RANK_ROUNDS; round++) {
    const next = new Array<number>(n).fill((1 - RANK_DAMPING) / n);
    edges.forEach((tos, from) => {
      const out = outCount[from]!;
      if (out === 0) return;
      const share = (RANK_DAMPING * score[from]!) / out;
      for (const to of tos) next[to]! += share;
    });
    score = next;
  }

  const tierOf = (i: number): number =>
    candidateIdx.has(i) ? 0 : oneHop.has(i) ? 1 : 2;

  const order = nodes.map((_, i) => i);
  order.sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    const sa = score[a]!;
    const sb = score[b]!;
    if (sb !== sa) return sb - sa;
    const pa = nodes[a]!.path;
    const pb = nodes[b]!.path;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return order;
}

function selectBody(
  node: FileNode,
  candidateByPath: ReadonlyMap<string, Candidate>,
  referencedBy: string | undefined,
): { content: string; reason: string } {
  const { file } = node;
  const patch = file.patch ?? "";
  const contents = file.contents ?? "";
  const candidate = candidateByPath.get(node.path);
  const snippet = candidate?.snippet ?? "";

  let content: string;
  if (patch && (contents.length === 0 || patch.length < contents.length)) {
    content = patch;
  } else if (contents) {
    content = contents;
  } else if (patch) {
    content = patch;
  } else {
    content = snippet;
  }

  const reason = node.isCandidate
    ? "candidate location"
    : referencedBy
      ? `referenced by ${referencedBy}`
      : "changed in PR";

  return { content, reason };
}

function findReferrer(
  targetIdx: number,
  nodes: readonly FileNode[],
  edges: ReadonlyMap<number, Set<number>>,
): string | undefined {
  let best: string | undefined;
  edges.forEach((tos, from) => {
    if (!tos.has(targetIdx)) return;
    const fromPath = nodes[from]!.path;
    if (best === undefined || fromPath < best) best = fromPath;
  });
  return best;
}

// ---------------------------------------------------------------------------
// buildTreesitterContextBundle — public main entry
// ---------------------------------------------------------------------------

/**
 * Assemble a token-budgeted `ContextBundle` using the enhanced tree-sitter
 * (pure-TS for now) symbol graph for TS/JS/Python, with regex fallback for
 * other languages. Returns the exact same shape as `buildContextBundle` from
 * repomap.ts so the engine can swap in transparently.
 *
 * Pure & deterministic: no clock reads, no RNG, stable tie-breaks by path.
 */
export function buildTreesitterContextBundle(
  args: BuildTreesitterContextBundleArgs,
): ContextBundle {
  const files = Array.isArray(args.files) ? args.files : [];
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const tokenBudget =
    typeof args.tokenBudget === "number" && args.tokenBudget > 0
      ? args.tokenBudget
      : DEFAULT_TOKEN_BUDGET;

  const candidatePaths = new Set(candidates.map((c) => c.filePath));
  const candidateByPath = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!candidateByPath.has(c.filePath)) candidateByPath.set(c.filePath, c);
  }

  const nodes = buildNodes(files, candidatePaths);
  const edges = buildEdges(nodes);
  const ranked = rankNodes(nodes, edges);

  const diffSummary =
    nodes.length === 0
      ? "No changed files."
      : nodes.map((n) => `${n.path} (${n.file.status})`).join("\n");

  // relatedSymbols: symbols in candidate files' refs that are defined somewhere
  // in the changed set. Uses defs + calls for richer coverage.
  const definedAnywhere = new Set<string>();
  for (const n of nodes) for (const d of n.defs) definedAnywhere.add(d);

  const relatedSymbols: string[] = [];
  const relatedSeen = new Set<string>();
  for (const n of nodes) {
    if (!n.isCandidate) continue;
    const sortedRefs = [...n.refs, ...n.calls].sort();
    for (const r of sortedRefs) {
      if (
        definedAnywhere.has(r) &&
        r.length > 0 &&
        !relatedSeen.has(r)
      ) {
        relatedSeen.add(r);
        relatedSymbols.push(r);
      }
    }
  }

  // Pack files within budget
  const packed: Array<{ path: string; content: string; reason: string }> = [];
  let used = 0;
  let packedAny = false;
  for (const idx of ranked) {
    const node = nodes[idx]!;
    const referrer = node.isCandidate
      ? undefined
      : findReferrer(idx, nodes, edges);
    const { content, reason } = selectBody(node, candidateByPath, referrer);
    if (content.length === 0) continue;
    const cost = estimateTokens(content);

    if (!packedAny) {
      packed.push({ path: node.path, content, reason });
      used += cost;
      packedAny = true;
      continue;
    }
    if (used + cost > tokenBudget) continue;
    packed.push({ path: node.path, content, reason });
    used += cost;
  }

  return {
    diffSummary,
    files: packed,
    relatedSymbols,
    tokenEstimate: used,
  };
}
