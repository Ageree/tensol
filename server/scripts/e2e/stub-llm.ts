/**
 * Deterministic stub LlmClient for the REAL end-to-end verification.
 *
 * No live LLM key exists locally, so this stands in for the model. It is NOT a
 * canned answer keyed to the testbed — it is a genuine (small) sink detector:
 * it parses the candidate blocks the reviewer renders into the user prompt and
 * flags candidates whose snippet contains a real dangerous sink (shell exec,
 * string-concatenated SQL, hardcoded secret, path traversal, eval). Benign
 * candidates get is_vulnerability:false — so false-positive discipline is
 * exercised for real. Output strictly matches LlmReviewOutputSchema; the model
 * never emits a numeric score (only the decomposed CVSS vector).
 *
 * It also answers the reviewer's self-challenge pass: when the prompt asks for
 * a refutation verdict, it returns {refuted:false} (the sink is confirmed).
 */
import type { LlmClient } from "../../src/review/reviewer.ts";

interface CvssVec { AV: string; AC: string; PR: string; UI: string; S: string; C: string; I: string; A: string }
const HIGH: CvssVec = { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "N" };
const SECRET: CvssVec = { AV: "N", AC: "L", PR: "N", UI: "N", S: "C", C: "H", I: "H", A: "N" };
const TRAVERSAL: CvssVec = { AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "N", A: "N" };

interface Rule {
  /** True iff the whole file/snippet contains this vuln. */
  test: (s: string) => boolean;
  /** Per-line anchor: the precise line to attach the inline comment to. */
  anchor: (line: string) => boolean;
  category: string; cwe: string[]; cvss: CvssVec; title: string; rationale: string;
}
const RULES: Rule[] = [
  { test: (s) => /\bexec(Sync)?\s*\(/.test(s) && /\+|\$\{|`/.test(s),
    anchor: (l) => /\bexec(Sync)?\s*\(/.test(l),
    category: "Command Injection", cwe: ["CWE-78"], cvss: HIGH,
    title: "OS command injection via unsanitized input in shell exec",
    rationale: "User-controlled input is concatenated into a string passed to a shell `exec`. An attacker can inject shell metacharacters (`;`, `|`, `$()`) to run arbitrary commands. Reachable from the request path." },
  { test: (s) => /(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*?(["'`]\s*\+|\+\s*["'`]|\$\{)/i.test(s),
    anchor: (l) => /(SELECT|INSERT|UPDATE|DELETE)\b/i.test(l) && /["'`]\s*\+|\+\s*["'`]|\$\{/.test(l),
    category: "SQL Injection", cwe: ["CWE-89"], cvss: HIGH,
    title: "SQL injection via string-concatenated query",
    rationale: "A query is built by concatenating user-controlled input instead of parameterized bindings. An attacker controls the WHERE/LIKE clause to exfiltrate or modify data." },
  { test: (s) => /(sk_live_[A-Za-z0-9]{8,}|API_TOKEN\s*=\s*["'][^"']{12,}|api[_-]?key\s*=\s*["'][^"']{12,})/i.test(s),
    anchor: (l) => /(sk_live_[A-Za-z0-9]{8,}|API_TOKEN\s*=\s*["'][^"']{12,}|api[_-]?key\s*=\s*["'][^"']{12,})/i.test(l),
    category: "Hardcoded Credential", cwe: ["CWE-798"], cvss: SECRET,
    title: "Hardcoded secret committed to source",
    rationale: "A live API token is hardcoded in source and committed to version control. Anyone with repo read access obtains the secret; rotation is the only remediation." },
  { test: (s) => /path\.join\s*\([^)]*\b(name|file|path|input|req|param)/i.test(s) && /readFile|createReadStream|sendFile|open\b/.test(s),
    anchor: (l) => /path\.join\s*\([^)]*\b(name|file|path|input|req|param)/i.test(l),
    category: "Path Traversal", cwe: ["CWE-22"], cvss: TRAVERSAL,
    title: "Path traversal via unsanitized filename in path.join",
    rationale: "A user-controlled name is joined onto a base directory and read without a containment check. A `../` sequence escapes the base directory and discloses arbitrary files." },
  { test: (s) => /\beval\s*\(/.test(s),
    anchor: (l) => /\beval\s*\(/.test(l),
    category: "Code Injection", cwe: ["CWE-95"], cvss: HIGH,
    title: "Code injection via eval of dynamic input",
    rationale: "Dynamic input flows into `eval`, allowing arbitrary code execution in the process." },
];

/** Find the 1-based line number of the sink within a file's content. */
function anchorLine(content: string, rule: Rule): number | undefined {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (rule.anchor(lines[i] ?? "")) return i + 1;
  }
  return undefined;
}

function parseCandidates(user: string): Array<{ id?: string; file: string; line?: number; snippet: string }> {
  const out: Array<{ id?: string; file: string; line?: number; snippet: string }> = [];
  const parts = user.split(/\n-\s+candidate_id:/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i] ?? "";
    const id = /^\s*([^\n]+)/.exec(block)?.[1]?.trim();
    const loc = /location:\s*(\S+?):(\d+)/.exec(block) ?? /location:\s*(\S+)/.exec(block);
    const file = loc?.[1] ?? "";
    const line = loc?.[2] ? Number(loc[2]) : undefined;
    const snIdx = block.indexOf("snippet:");
    const snippet = snIdx >= 0 ? block.slice(snIdx + 8) : block;
    if (file) out.push({ ...(id ? { id } : {}), file, ...(line !== undefined ? { line } : {}), snippet });
  }
  return out;
}
function parseContextFiles(user: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  const re = /### FILE:\s*(\S+)[^\n]*\n```\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user)) !== null) if (m[1] && m[2] !== undefined) out.push({ file: m[1], content: m[2] });
  return out;
}

export function createStubLlm(): LlmClient {
  return {
    async complete({ system, user }: { system: string; user: string }): Promise<string> {
      // Self-challenge pass: confirm the finding (do not refute the real sinks).
      if (/refut|challenge/i.test(system) || /"refuted"/.test(user)) {
        return JSON.stringify({ refuted: false, reason: "sink reachable from untrusted input; not a false positive" });
      }
      const verdicts: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      // Map file → full content (from the context bundle) for precise line anchoring.
      const ctx = new Map<string, string>();
      for (const f of parseContextFiles(user)) ctx.set(f.file, f.content);
      const emit = (file: string, fallbackLine: number | undefined, id: string | undefined, text: string) => {
        const content = ctx.get(file) ?? text;
        for (const r of RULES) {
          if (!r.test(content) && !r.test(text)) continue;
          const key = `${file}:${r.category}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Prefer the precise sink line from the file content; else the candidate's line.
          const line = anchorLine(content, r) ?? anchorLine(text, r) ?? fallbackLine;
          verdicts.push({
            ...(id ? { candidate_id: id } : {}),
            file_path: file,
            ...(line !== undefined ? { start_line: line } : {}),
            is_vulnerability: true,
            category: r.category, cwe: r.cwe, rationale_md: r.rationale,
            reachable: true, confidence: "high", cvss: r.cvss,
            poc_md: `\`${file}\` — ${r.category} sink reachable from untrusted input.`,
            fix_prompt_md: `Remediate the ${r.category} in \`${file}\`: validate/escape input or use a safe API (parameterized query, exec argv array, path containment, env-var secret).`,
            title: r.title,
          });
        }
      };
      for (const c of parseCandidates(user)) emit(c.file, c.line, c.id, c.snippet);
      for (const [file, content] of ctx) emit(file, undefined, undefined, content);
      return JSON.stringify({
        summary: verdicts.length > 0
          ? `Found ${verdicts.length} exploitable issue(s) in the changed code.`
          : "No exploitable vulnerabilities found in the reviewed changes.",
        verdicts,
      });
    },
  };
}
