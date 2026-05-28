/**
 * 003-whitebox — token-budgeted context assembly ("repo map").
 *
 * The reviewer never feeds whole repos to the LLM. Given the changed files +
 * the candidates worth investigating, this module builds a *small, relevant*
 * `ContextBundle`: it extracts symbol defs/refs with a language-agnostic regex
 * indexer, wires a reference graph among the changed files, ranks files by
 * relevance to the candidate locations (candidate files first, then 1-hop
 * neighbours, then a degree-weighted PageRank-ish score), and packs file bodies
 * — preferring the diff patch when it is shorter — until a token budget is hit.
 *
 * Everything here is PURE and DETERMINISTIC: no clock reads, no RNG, stable tie
 * breaks by path so repeated runs produce byte-identical output.
 *
 * Design rationale: `docs/research/2026-05-29-hacktron-whitebox-dossier.md` §7
 * (focused context > dumping the repo) and §10 (deterministic engine).
 */
import type { DiffFile, Candidate, ContextBundle } from "../types.ts";

/** Default packing budget in tokens. */
const DEFAULT_TOKEN_BUDGET = 8000;
/** Chars-per-token approximation used everywhere (cheap, deterministic). */
const CHARS_PER_TOKEN = 4;
/** Rounds of degree-weighted score propagation. */
const RANK_ROUNDS = 4;
/** Damping factor for the PageRank-ish propagation. */
const RANK_DAMPING = 0.85;

/**
 * Pluggable symbol extraction. An indexer turns a file's text into the set of
 * symbols it *defines* and the set of symbols / module specifiers it
 * *references*. Kept tiny so alternative (tree-sitter) implementations can drop
 * in later without touching the bundler.
 */
export interface SymbolIndexer {
  extract(file: { path: string; content: string }): {
    defs: string[];
    refs: string[];
  };
}

/** Rough token estimate: ceil(chars / 4). Deterministic, no model call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Append `value` to `out` if not already present (order-preserving dedup). */
function pushUnique(out: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) return;
  seen.add(value);
  out.push(value);
}

// ---------------------------------------------------------------------------
// Regex symbol indexer
// ---------------------------------------------------------------------------

/**
 * Definition patterns spanning JS/TS, Python, Go, Java/C-family. Heuristic but
 * useful — each pattern captures the declared name in group 1. We intentionally
 * over-collect a little; downstream ranking tolerates noise far better than it
 * tolerates missing a real edge.
 */
const DEF_PATTERNS: readonly RegExp[] = [
  // function NAME( | async function NAME(
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // class NAME | interface NAME | enum NAME | struct NAME | type NAME
  /\b(?:class|interface|enum|struct|type)\s+([A-Za-z_$][\w$]*)/g,
  // const/let/var NAME = | const NAME: T =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
  // Python / Ruby: def NAME(
  /\bdef\s+([A-Za-z_][\w]*)\s*[(:]?/g,
  // Go: func NAME( | func (recv) NAME(
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/g,
  // Java/TS method-ish: <modifiers> returnType NAME( — capture NAME before "("
  // (also matches `void login()` inside a class). Conservative: requires the
  // name be immediately followed by "(" and preceded by a type-ish token.
  //
  // ReDoS-hardened: the type-token alternative is a GREEDY, whitespace-free,
  // length-bounded class (`[A-Z][\w<>,]{0,80}`) instead of the original lazy
  // `[A-Z][\w<>,\s]*?`. The old class let its inner `\s` overlap the trailing
  // `\s+` separator, giving catastrophic O(n^2) backtracking on inputs where
  // the `(...){ ` tail never matched. The arg list is also tightened to
  // `[^;{]*` so it can't backtrack across a `{`.
  /\b(?:public|private|protected|static|final|synchronized|void|[A-Z][\w<>,]{0,80})\s+([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*\{/g,
];

/**
 * Per-file byte ceiling for symbol extraction. Files larger than this skip the
 * regex sweep entirely (defense-in-depth against pathological/adversarial
 * inputs blocking the single-threaded Bun event loop). The file's content is
 * still available to the reviewer via the context bundle — only the symbol
 * graph edges from this oversized file are dropped.
 */
const MAX_INDEX_BYTES = 256 * 1024;

/** Import / require module-specifier patterns (capture the specifier string). */
const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import ... from "X" / import "X"
  /\bimport\b[^'"`\n]*?from\s*['"`]([^'"`]+)['"`]/g,
  /\bimport\s*['"`]([^'"`]+)['"`]/g,
  // require("X")
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  // Python: from X import ... / import X
  /\bfrom\s+([A-Za-z_.][\w.]*)\s+import\b/g,
  /\bimport\s+([A-Za-z_.][\w.]*)/g,
  // Go: import "X"  (single + inside blocks)
  /^\s*(?:[A-Za-z_]\w*\s+)?['"`]([^'"`]+)['"`]\s*$/gm,
];

/** Identifier-reference pattern: NAME( call sites + bare identifiers. */
const CALL_REF_PATTERN = /\b([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Imported binding names — the symbols a file pulls in from elsewhere. These
 * are references too (and crucial for resolving edge A -> B when B *defines*
 * the imported name). Captures the `{ ... }` group of ES named imports and the
 * `from X import a, b` group of Python imports.
 */
const IMPORTED_BINDINGS_PATTERNS: readonly RegExp[] = [
  // import { a, b as c } from "X"
  /\bimport\s*\{([^}]*)\}\s*from/g,
  // from X import a, b, c
  /\bfrom\s+[A-Za-z_.][\w.]*\s+import\s+([^\n#]+)/g,
];

/** Split a comma list of import bindings into bare names ("a as b" -> "a"). */
function splitImportBindings(group: string): string[] {
  return group
    .split(",")
    .map((part) => {
      const trimmed = part.trim().replace(/[()]/g, "");
      // Take the source name before "as"; strip leading "* as" namespace form.
      const name = trimmed.split(/\s+as\s+/i)[0]?.trim() ?? "";
      return name === "*" ? "" : name;
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** Keywords that are never useful as symbol references (reduce noise). */
const STOPWORDS: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "class",
  "const",
  "let",
  "var",
  "def",
  "func",
  "import",
  "from",
  "require",
  "new",
  "typeof",
  "await",
  "async",
  "yield",
  "throw",
  "super",
  "this",
  "else",
  "do",
  "in",
  "of",
  "case",
  "public",
  "private",
  "protected",
  "static",
  "void",
  "interface",
  "enum",
  "struct",
  "type",
]);

/**
 * Language-agnostic regex symbol indexer. Heuristic by design: it favours
 * recall over precision and never throws on malformed input.
 */
export class RegexSymbolIndexer implements SymbolIndexer {
  extract(file: { path: string; content: string }): {
    defs: string[];
    refs: string[];
  } {
    const content = file?.content ?? "";
    const defs: string[] = [];
    const defSeen = new Set<string>();
    const refs: string[] = [];
    const refSeen = new Set<string>();

    // Bound CPU on oversized inputs (ReDoS / O(n^2) backtracking guard).
    if (content.length > MAX_INDEX_BYTES) {
      return { defs, refs };
    }

    for (const pattern of DEF_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const name = m[1];
        if (name && !STOPWORDS.has(name)) pushUnique(defs, defSeen, name);
        // Guard against zero-width matches creating an infinite loop.
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }

    for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const spec = m[1];
        if (spec) pushUnique(refs, refSeen, spec);
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }

    for (const pattern of IMPORTED_BINDINGS_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const group = m[1];
        if (group) {
          for (const name of splitImportBindings(group)) {
            if (!STOPWORDS.has(name)) pushUnique(refs, refSeen, name);
          }
        }
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }

    CALL_REF_PATTERN.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CALL_REF_PATTERN.exec(content)) !== null) {
      const name = cm[1];
      if (name && !STOPWORDS.has(name)) pushUnique(refs, refSeen, name);
      if (cm.index === CALL_REF_PATTERN.lastIndex) CALL_REF_PATTERN.lastIndex++;
    }

    return { defs, refs };
  }
}

// ---------------------------------------------------------------------------
// Context bundling
// ---------------------------------------------------------------------------

interface FileNode {
  path: string;
  file: DiffFile;
  defs: Set<string>;
  refs: Set<string>;
  isCandidate: boolean;
}

/** Build the per-file index nodes, deterministically ordered by path. */
function buildNodes(
  files: readonly DiffFile[],
  candidatePaths: ReadonlySet<string>,
  indexer: SymbolIndexer,
): FileNode[] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted.map((file) => {
    const content = file.contents ?? file.patch ?? "";
    const { defs, refs } = indexer.extract({ path: file.path, content });
    return {
      path: file.path,
      file,
      defs: new Set(defs),
      refs: new Set(refs),
      isCandidate: candidatePaths.has(file.path),
    };
  });
}

/**
 * Directed reference edges A -> B when A references a symbol that B defines, or
 * A imports a module specifier whose basename matches B's path. Returns a map
 * from node index to the set of node indices it points to.
 */
function buildEdges(nodes: readonly FileNode[]): Map<number, Set<number>> {
  // Map a defined symbol -> indices of nodes defining it.
  const defOwners = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    for (const d of node.defs) {
      const arr = defOwners.get(d);
      if (arr) arr.push(i);
      else defOwners.set(d, [i]);
    }
  });

  // Map a path "stem" (basename without extension) -> node index, for resolving
  // import specifiers like './crypto' to src/crypto.ts.
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
    for (const ref of node.refs) {
      // Symbol reference resolution.
      const owners = defOwners.get(ref);
      if (owners) for (const o of owners) addEdge(i, o);
      // Module-specifier resolution by basename stem.
      const stem = pathStem(ref);
      const target = stemToIndex.get(stem);
      if (target !== undefined) addEdge(i, target);
    }
  });

  return edges;
}

/** basename without directory or extension, normalising "./x" / "x.ts". */
function pathStem(p: string): string {
  const noQuery = p.split(/[?#]/)[0] ?? p;
  const base = noQuery.split("/").pop() ?? noQuery;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Rank nodes. Priority tiers (highest first):
 *   tier 0: candidate files
 *   tier 1: files 1 hop from a candidate (either direction)
 *   tier 2: everything else, ordered by a degree-weighted PageRank-ish score
 * Ties within a tier broken by path (deterministic).
 * Returns node indices in descending relevance.
 */
function rankNodes(
  nodes: readonly FileNode[],
  edges: ReadonlyMap<number, Set<number>>,
): number[] {
  const n = nodes.length;
  if (n === 0) return [];

  // Undirected adjacency for "1-hop neighbour" detection.
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

  // PageRank-ish score over the directed graph (degree-weighted propagation).
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
    if (sb !== sa) return sb - sa; // higher score first
    // Stable, deterministic tie-break by path.
    const pa = nodes[a]!.path;
    const pb = nodes[b]!.path;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return order;
}

/** Pick the body text + a short reason for a file given its ranking context. */
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

  // Prefer the patch when present and strictly shorter than full contents;
  // otherwise prefer contents; fall back to the candidate snippet.
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

/**
 * For a non-candidate node, find a candidate (or candidate-file) path that
 * references it, for a human-readable "referenced by X" reason. Deterministic:
 * picks the lexicographically smallest such referrer path.
 */
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

export interface BuildContextBundleArgs {
  files: DiffFile[];
  candidates: Candidate[];
  tokenBudget?: number;
  indexer?: SymbolIndexer;
}

/**
 * Assemble a token-budgeted `ContextBundle` from the changed files + the
 * candidate locations. Pure & deterministic.
 *
 * Packing policy: walk files in ranked order; a candidate file is always
 * packed first even if it alone exceeds the budget (the LLM must see the
 * vulnerable code). Subsequent files are packed only while they fit within the
 * remaining budget, so huge unrelated files are skipped rather than truncated.
 */
export function buildContextBundle(args: BuildContextBundleArgs): ContextBundle {
  const files = Array.isArray(args.files) ? args.files : [];
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const tokenBudget =
    typeof args.tokenBudget === "number" && args.tokenBudget > 0
      ? args.tokenBudget
      : DEFAULT_TOKEN_BUDGET;
  const indexer = args.indexer ?? new RegexSymbolIndexer();

  const candidatePaths = new Set(candidates.map((c) => c.filePath));
  // First candidate per path (deterministic — candidates assumed pre-ordered).
  const candidateByPath = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!candidateByPath.has(c.filePath)) candidateByPath.set(c.filePath, c);
  }

  const nodes = buildNodes(files, candidatePaths, indexer);
  const edges = buildEdges(nodes);
  const ranked = rankNodes(nodes, edges);

  // diffSummary: deterministic list of changed paths + statuses.
  const diffSummary =
    nodes.length === 0
      ? "No changed files."
      : nodes
          .map((n) => `${n.path} (${n.file.status})`)
          .join("\n");

  // relatedSymbols: union of symbols referenced by candidate files that are
  // defined somewhere in the changed set. Deterministic ordering.
  const definedAnywhere = new Set<string>();
  for (const n of nodes) for (const d of n.defs) definedAnywhere.add(d);
  const relatedSymbols: string[] = [];
  const relatedSeen = new Set<string>();
  for (const n of nodes) {
    if (!n.isCandidate) continue;
    // Refs in a stable, sorted order for determinism.
    const sortedRefs = [...n.refs].sort();
    for (const r of sortedRefs) {
      if (definedAnywhere.has(r)) pushUnique(relatedSymbols, relatedSeen, r);
    }
  }

  // Pack file bodies within the token budget.
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
      // Always include the first (highest-ranked) file even if oversized.
      packed.push({ path: node.path, content, reason });
      used += cost;
      packedAny = true;
      continue;
    }
    if (used + cost > tokenBudget) continue; // skip; never truncate mid-file.
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
