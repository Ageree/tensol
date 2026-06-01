/**
 * Deterministic recon (NO LLM) — OpenHack source-inventory port.
 *
 * Scans changed files line-by-line for ~14 kinds of security-relevant tokens
 * (routes, sinks, inputs, exposures) and emits {@link RoutingUnit}s — the
 * deterministic first stage of the Deep Whitebox Research pipeline. The PATTERNS
 * dict and SKIP set are ported VERBATIM from Hadrian Security's OpenHack
 * `inventory_patterns.py` (MIT — see ./prompts/OPENHACK-LICENSE).
 *
 * Pure function: no I/O, no mutation of inputs. Each matching line yields one
 * RoutingUnit per matching kind (a single line may match several kinds).
 */
import type { DiffFile } from "../types.ts";
import type {
  RoutingUnit,
  RoutingUnitKind,
  RoutingUnitCategory,
} from "./types.ts";

/** Maximum characters retained from a matched source line in `snippet`. */
const SNIPPET_MAX = 300;

/**
 * Path segments that mark a file as not-source — any file whose path contains
 * one of these as a `/`-delimited segment is skipped entirely. Ported VERBATIM
 * from OpenHack `inventory_patterns.py` SKIP.
 */
const SKIP: Set<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "__pycache__",
]);

/**
 * Lowercased token patterns per {@link RoutingUnitKind}. A line matches a kind
 * if the (lowercased) line contains any of the kind's tokens. Ported VERBATIM
 * from OpenHack `inventory_patterns.py` PATTERNS.
 */
const PATTERNS: Record<RoutingUnitKind, string[]> = {
  route: ["route(", "@app.", "router.", "get(", "post(", "controller", "location "],
  sql: ["select ", "insert ", "update ", "delete ", "raw(", "execute(", "query("],
  command: ["subprocess", "exec(", "execsync(", "execfile", "system(", "spawn(", "spawnsync(", "shell_exec", "shell=true"],
  file: ["open(", "readfile", "writefile", "send_file", "download", "file_get_contents"],
  upload: ["upload", "multipart", "filename", "content-type", "attachment"],
  ssrf: ["requests.", "fetch(", "http.get", "httpclient", "curl", "proxy_pass"],
  secret: ["secret", "token", "password", "api_key", ".env", "credential"],
  parser: ["xml", "yaml.load", "deserialize", "pickle", "template", "unserialize", "erb"],
  state: ["csrf", "state", "approve", "reset", "callback", "redirect"],
  headers: ["access-control-allow-origin", "x-frame-options", "frame-ancestors", "content-security-policy", "samesite"],
  host: ["http_host", "x-forwarded", "forwarded-host", "host header", "wwwroot"],
  identity: ["oauth", "oidc", "saml", "shibboleth", "ldap", "sso", "mfa"],
  object: ["userid", "courseid", "groupid", "contextid", "tenant", "itemid", "instanceid"],
  xss: ["innerhtml", "ng-bind-html", "html_writer", "format_text", "format_string", "param_raw", "param_notags"],
};

/** Maps each detected kind to its recon bucket (OpenHack DETAILS keys). */
const KIND_CATEGORY: Record<RoutingUnitKind, RoutingUnitCategory> = {
  route: "routes",
  state: "inputs",
  host: "inputs",
  identity: "inputs",
  object: "inputs",
  upload: "inputs",
  sql: "sinks",
  command: "sinks",
  file: "sinks",
  parser: "sinks",
  xss: "sinks",
  ssrf: "sinks",
  secret: "exposures",
  headers: "exposures",
};

/**
 * Stable iteration order for kinds — drives both the order in which a single
 * line's units are emitted and the global ID sequence. Mirrors PATTERNS
 * insertion order so it is deterministic across runs.
 */
const KIND_ORDER: readonly RoutingUnitKind[] = Object.keys(PATTERNS) as RoutingUnitKind[];

/** True when the file path contains a SKIP segment (split on `/`). */
function isSkipped(path: string): boolean {
  for (const segment of path.split("/")) {
    if (SKIP.has(segment)) {
      return true;
    }
  }
  return false;
}

/** Zero-pad a 1-based sequence number to a minimum 3-digit "U###" id. */
function unitId(seq: number): string {
  return "U" + String(seq).padStart(3, "0");
}

/**
 * Deterministically build the routing-unit inventory for a set of changed
 * files. For each non-skipped file, each 1-indexed line is matched against
 * every kind's token list; every matching kind emits one RoutingUnit. IDs are
 * sequential ("U001", "U002", …) across the whole run.
 *
 * @param files Changed files (PR diff or whitebox repo files). `contents` is
 *   preferred, falling back to `patch`, then empty string.
 * @returns A new RoutingUnit[] (inputs are never mutated).
 */
export function buildRoutingUnits(files: DiffFile[]): RoutingUnit[] {
  const units: RoutingUnit[] = [];
  let seq = 0;

  for (const file of files) {
    if (isSkipped(file.path)) {
      continue;
    }
    const text = file.contents ?? file.patch ?? "";
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const original = lines[i] ?? "";
      const lowered = original.toLowerCase();
      const line = i + 1;

      for (const kind of KIND_ORDER) {
        const matched = PATTERNS[kind].filter((token) => lowered.includes(token));
        if (matched.length === 0) {
          continue;
        }
        seq += 1;
        units.push({
          id: unitId(seq),
          kind,
          category: KIND_CATEGORY[kind],
          filePath: file.path,
          line,
          snippet: original.trim().slice(0, SNIPPET_MAX),
          signals: matched,
        });
      }
    }
  }

  return units;
}
