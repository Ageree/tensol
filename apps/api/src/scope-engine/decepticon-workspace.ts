// 2026-05-12 — Decepticon workspace findings extractor.
//
// Decepticon's `recon` / `exploit` / `postexploit` agents write findings to
// `/workspace/findings/FIND-NNN.md` (markdown) and append a structured
// timeline entry to `/workspace/timeline.jsonl`. They DO NOT emit
// `subagent_tool_result{tool=report_finding}` events back through the
// LangGraph stream — that's a separate code path that doesn't seem to be
// wired in the docker image we use.
//
// This module shells out to `docker exec decepticon-sandbox` to read those
// workspace artifacts after a Decepticon run completes, and converts them
// into Tensol-side `candidate_findings` rows. Best-effort: any docker /
// parse error is logged and swallowed — the scan still ends cleanly even
// if extraction fails.
//
// Container name defaults to `decepticon-sandbox` and is overridable via
// `DECEPTICON_SANDBOX_CONTAINER` env. Workspace path is `/workspace` by
// convention (per recon.md prompt CRITICAL_RULES).

import { spawn } from 'node:child_process';

const DEFAULT_CONTAINER = 'decepticon-sandbox';
const WORKSPACE_DIR = '/workspace';

const sandboxContainer = (): string => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.['DECEPTICON_SANDBOX_CONTAINER'] || DEFAULT_CONTAINER;
};

const runDockerExec = (args: readonly string[], timeoutMs = 5000): Promise<string> => {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', sandboxContainer(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
};

export interface DecepticonWorkspaceFinding {
  /** Finding ID assigned by Decepticon (e.g. FIND-001). */
  readonly id: string;
  /** Vulnerability class label (xss, sqli, ssrf, idor, info_disclosure, ...). */
  readonly type: string;
  /** Severity bucket as recorded by Decepticon. */
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** ISO timestamp from timeline.jsonl. */
  readonly ts: string;
  /** Decepticon-side agent role (recon, exploit, postexploit, ...). */
  readonly agent: string;
  /** Optional URL/host that the finding targets. */
  readonly affectedUrl?: string;
  /** Free-form description / payload extracted from the markdown report. */
  readonly description?: string;
  /** First H1 stripped of "[SEVERITY] " prefix. */
  readonly title?: string;
  /** CVSS base score (0-10). */
  readonly cvssScore?: number;
  /** Full CVSS vector string. */
  readonly cvssVector?: string;
  /** CWE identifiers, e.g. ["CWE-89"]. */
  readonly cwe?: readonly string[];
  /** MITRE ATT&CK technique identifiers, e.g. ["T1190"]. */
  readonly mitre?: readonly string[];
  /** Confidence rating from agent ("verified" / "unverified"). */
  readonly confidence?: string;
  /** Phase label ("initial-access" / "recon" / "post-exploit" / etc). */
  readonly phase?: string;
  /** Steps-to-reproduce body section verbatim (preserves code fences). */
  readonly stepsToReproduce?: string;
  /** Impact body section verbatim. */
  readonly impact?: string;
  /** Remediation body section verbatim. */
  readonly remediation?: string;
  /** Evidence file paths parsed from `## Evidence` bulleted list. */
  readonly evidencePaths?: readonly string[];
}

const FINDINGS_DIR = `${WORKSPACE_DIR}/findings`;

/**
 * Parse a Decepticon finding markdown file. Format observed (recon agent
 * 2026-05-12) — YAML frontmatter between `---` markers, then markdown body:
 *
 *     ---
 *     id: FIND-005
 *     severity: critical
 *     cvss_score: 9.1
 *     cwe: [CWE-89]
 *     affected_target: "192.168.100.10:3030"
 *     affected_component: "Juice Shop /rest/user/login"
 *     discovered_at: "2026-05-12T00:20:00Z"
 *     phase: initial-access
 *     agent: recon
 *     ...
 *     ---
 *
 *     # [CRITICAL] SQL Injection in Juice Shop Login Leads to ...
 *
 *     ## Description
 *     ...
 *
 * Filename also encodes severity + slug:
 * `critical-sql-injection-admin-jwt-compromise.md` → severity=critical,
 * type=sql-injection (first slug word), slug=full title.
 */

// CWE → Tensol vulnerability class. Canonical, language-independent.
// Tried first; falls back to slug-based inference.
const CWE_TO_TYPE: Record<string, string> = {
  'CWE-89': 'sqli', // SQL injection
  'CWE-79': 'xss_reflected', // Cross-site scripting
  'CWE-918': 'ssrf', // Server-side request forgery
  'CWE-22': 'path_traversal', // Path traversal
  'CWE-23': 'path_traversal', // Relative path traversal
  'CWE-36': 'path_traversal', // Absolute path traversal
  'CWE-78': 'rce', // OS command injection
  'CWE-94': 'rce', // Code injection
  'CWE-77': 'rce', // Command injection (generic)
  'CWE-639': 'idor', // Authorization bypass through user-controlled key
  'CWE-284': 'broken_auth', // Improper access control
  'CWE-285': 'broken_auth', // Improper authorization
  'CWE-287': 'broken_auth', // Improper authentication
  'CWE-306': 'broken_auth', // Missing auth for critical function
  'CWE-862': 'broken_auth', // Missing authorization
  'CWE-863': 'broken_auth', // Incorrect authorization
  'CWE-200': 'info_disclosure', // Exposure of sensitive info
  'CWE-209': 'info_disclosure', // Information exposure through error message
  'CWE-538': 'info_disclosure', // Insertion of sensitive info into externally accessible file
  'CWE-548': 'info_disclosure', // Exposure of info through dir listing
  'CWE-326': 'crypto_weakness', // Inadequate encryption strength
  'CWE-327': 'crypto_weakness', // Use of broken/risky cryptographic algorithm
  'CWE-330': 'crypto_weakness', // Use of insufficiently random values
  'CWE-611': 'xxe', // XML external entity reference
  'CWE-352': 'csrf', // Cross-site request forgery
  'CWE-434': 'rce', // Unrestricted file upload
  'CWE-502': 'rce', // Deserialization of untrusted data
  'CWE-601': 'open_redirect', // URL redirection to untrusted site
  'CWE-798': 'crypto_weakness', // Hardcoded credentials
};

const SLUG_TO_TYPE: Record<string, string> = {
  // OWASP top class names
  sql: 'sqli',
  sqli: 'sqli',
  xss: 'xss_reflected',
  ssrf: 'ssrf',
  rce: 'rce',
  lfi: 'lfi',
  rfi: 'lfi',
  idor: 'idor',
  csrf: 'csrf',
  xxe: 'xxe',
  // exposure / disclosure family
  ftp: 'info_disclosure',
  exposed: 'info_disclosure',
  hidden: 'info_disclosure',
  open: 'info_disclosure',
  leaked: 'info_disclosure',
  config: 'info_disclosure',
  setup: 'info_disclosure',
  backup: 'info_disclosure',
  debug: 'info_disclosure',
  swagger: 'info_disclosure',
  // auth class
  unauthenticated: 'broken_auth',
  unauth: 'broken_auth',
  jwt: 'broken_auth',
  // crypto
  textbook: 'crypto_weakness',
  weak: 'crypto_weakness',
  rsa: 'crypto_weakness',
  // path / file
  poison: 'path_traversal',
  traversal: 'path_traversal',
  // common app names that map to info_disclosure when discovered
  decepticon: 'info_disclosure',
  challenges: 'info_disclosure',
  airtunes: 'info_disclosure',
  sentinel: 'broken_auth',
  dvwa: 'info_disclosure',
  postgres: 'info_disclosure',
  postgresql: 'info_disclosure',
  redis: 'info_disclosure',
  langgraph: 'info_disclosure',
  // App prefixes seen in real scans (scan #9 — juice-shop, b2b, etc).
  juice: 'info_disclosure',
  b2b: 'info_disclosure',
  b2c: 'info_disclosure',
  apple: 'info_disclosure',
  // Additional vulnerability class prefixes.
  injection: 'sqli',
  command: 'rce',
  deserialization: 'rce',
  prototype: 'rce',
  upload: 'rce',
  auth: 'broken_auth',
  authentication: 'broken_auth',
  authorization: 'broken_auth',
  session: 'broken_auth',
  redirect: 'open_redirect',
  cors: 'info_disclosure',
  // catch-all hint for vulnerability categories
  vulnerabilities: 'unknown',
};

const inferTypeFromSlug = (slug: string): string => {
  const firstWord = slug.split('-')[0]?.toLowerCase() ?? '';
  return SLUG_TO_TYPE[firstWord] ?? 'unknown';
};

/**
 * Parse a YAML bracketed array value like `[CWE-89]` or `[T1190, T1059]`
 * into a string array. Returns empty array if the input is not bracketed
 * or contains only whitespace. Also accepts bare values without brackets
 * (treated as single-element array).
 */
export const parseYamlArray = (raw: string): readonly string[] => {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let inner = trimmed;
  if (inner.startsWith('[') && inner.endsWith(']')) {
    inner = inner.slice(1, -1);
  }
  return inner
    .split(',')
    .map((s) => s.trim())
    .map((s) => {
      // strip wrapping quotes per element
      if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
      if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
      return s;
    })
    .filter((s) => s.length > 0);
};

/**
 * Split markdown body (with frontmatter already stripped) into sections
 * keyed by H2 heading. Section keys are lowercased + non-alphanumeric
 * chars replaced with underscore: `## Steps to Reproduce` → key
 * `steps_to_reproduce`; `## Impact & Risk` → `impact_risk`. Bodies are
 * preserved verbatim (including any ``` code fences). Empty section
 * bodies map to empty string.
 */
export const parseMarkdownSections = (body: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = body.split('\n');
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  // Track whether we are inside a fenced code block so we don't misparse
  // a `## ` inside a code fence as a new section header.
  let inFence = false;
  const flush = () => {
    if (currentKey !== null) {
      out[currentKey] = currentLines.join('\n').replace(/\s+$/, '');
    }
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      if (currentKey !== null) currentLines.push(line);
      continue;
    }
    if (!inFence) {
      const headerMatch = line.match(/^##\s+(.+?)\s*$/);
      if (headerMatch) {
        flush();
        const raw = headerMatch[1] ?? '';
        const key = raw
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        currentKey = key;
        currentLines = [];
        continue;
      }
    }
    if (currentKey !== null) currentLines.push(line);
  }
  flush();
  return out;
};

const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITY_VALUES)[number];
const isSeverity = (v: string): v is Severity =>
  (SEVERITY_VALUES as readonly string[]).includes(v);

interface FilenameParts {
  readonly severity: Severity;
  readonly slug: string;
}

const parseFilename = (filename: string): FilenameParts | null => {
  const noExt = filename.replace(/\.md$/i, '');
  const idx = noExt.indexOf('-');
  if (idx < 0) return null;
  const sev = noExt.slice(0, idx).toLowerCase();
  if (isSeverity(sev)) {
    return { severity: sev, slug: noExt.slice(idx + 1) };
  }
  // Phase 3.1 sub-commit 4 — upstream Decepticon recon canonical filename
  // is `FIND-NNN.md` (per finding-protocol/SKILL.md and recon.md Rule 4).
  // Severity lives in the YAML frontmatter, not the filename. Accept it
  // as a placeholder pair so the markdown parser proceeds; the real
  // severity is read from frontmatter at parseFindingMarkdown:374.
  const upper = noExt.toUpperCase();
  if (/^FIND-\d+$/.test(upper)) {
    return { severity: 'info', slug: noExt };
  }
  return null;
};

interface Frontmatter {
  readonly raw: Record<string, string>;
}

const parseFrontmatter = (markdown: string): Frontmatter | null => {
  // Match opening --- on its own line then capture until closing ---.
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) return null;
  const body = match[1] ?? '';
  const raw: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // strip wrapping quotes
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    raw[key] = value;
  }
  return { raw };
};

const parseEvidenceList = (rawSection: string | undefined): readonly string[] => {
  if (!rawSection) return [];
  const out: string[] = [];
  for (const line of rawSection.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!m) continue;
    const cleaned = m[1]?.trim() ?? '';
    if (cleaned) out.push(cleaned);
  }
  return out;
};

const stripSeverityPrefix = (h1: string): string => {
  return h1.replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*/i, '').trim();
};

export const parseFindingMarkdown = (
  filename: string,
  body: string,
): DecepticonWorkspaceFinding | null => {
  const parts = parseFilename(filename);
  if (!parts) return null;
  const fm = parseFrontmatter(body);
  const fmRaw = fm?.raw ?? {};
  const id = fmRaw['id'] ?? filename.replace(/\.md$/i, '').slice(0, 64);
  const severityFm = (fmRaw['severity'] ?? '').toLowerCase();
  const severity: Severity = isSeverity(severityFm) ? severityFm : parts.severity;
  // CWE-driven type inference preferred over slug heuristics; both can be
  // present, in which case CWE wins because it's canonical.
  const cweList = fmRaw['cwe'] ? parseYamlArray(fmRaw['cwe']) : [];
  const firstCwe = cweList[0];
  const cweType = firstCwe ? CWE_TO_TYPE[firstCwe] : undefined;
  const findingType = cweType ?? inferTypeFromSlug(parts.slug);
  const ts = fmRaw['discovered_at'] || fmRaw['ts'] || new Date().toISOString();
  const agent = fmRaw['agent'] || 'decepticon';
  // Build affectedUrl from affected_target + affected_component when target
  // looks like host:port and component looks like a URL path.
  let affectedUrl: string | undefined;
  const affectedTarget = fmRaw['affected_target'];
  const affectedComponent = fmRaw['affected_component'];
  if (affectedTarget) {
    const componentPath =
      affectedComponent && affectedComponent.includes(' ')
        ? (affectedComponent.split(' ').find((s) => s.startsWith('/')) ?? '')
        : (affectedComponent ?? '');
    affectedUrl = `http://${affectedTarget}${componentPath}`;
  }
  // Pull a short description from the body — first H1 line or first
  // non-frontmatter sentence.
  const afterFrontmatter = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
  const h1Match = afterFrontmatter.match(/^#\s+(.+)$/m);
  const description = h1Match?.[1]?.trim() ?? afterFrontmatter.split('\n')[0]?.trim() ?? '';
  const title = h1Match?.[1] ? stripSeverityPrefix(h1Match[1]) : undefined;

  // Numeric + array fields from frontmatter.
  const cvssRaw = fmRaw['cvss_score'];
  const cvssNum = cvssRaw ? Number.parseFloat(cvssRaw) : NaN;
  const cvssScore = Number.isFinite(cvssNum) ? cvssNum : undefined;
  const cvssVector = fmRaw['cvss_vector'] || undefined;
  const mitreList = fmRaw['mitre'] ? parseYamlArray(fmRaw['mitre']) : [];
  const confidence = fmRaw['confidence'] || undefined;
  const phase = fmRaw['phase'] || undefined;

  // Section bodies parsed from H2 headers.
  const sections = parseMarkdownSections(afterFrontmatter);
  const stepsToReproduce =
    sections['steps_to_reproduce'] || sections['reproduction'] || undefined;
  const impact = sections['impact'] || sections['impact_risk'] || undefined;
  const remediation =
    sections['remediation'] || sections['mitigation'] || sections['fix'] || undefined;
  const evidencePaths = parseEvidenceList(sections['evidence']);

  return {
    id,
    type: findingType,
    severity,
    ts,
    agent,
    ...(affectedUrl ? { affectedUrl } : {}),
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
    ...(cvssScore !== undefined ? { cvssScore } : {}),
    ...(cvssVector ? { cvssVector } : {}),
    ...(cweList.length > 0 ? { cwe: cweList } : {}),
    ...(mitreList.length > 0 ? { mitre: mitreList } : {}),
    ...(confidence ? { confidence } : {}),
    ...(phase ? { phase } : {}),
    ...(stepsToReproduce ? { stepsToReproduce } : {}),
    ...(impact ? { impact } : {}),
    ...(remediation ? { remediation } : {}),
    ...(evidencePaths.length > 0 ? { evidencePaths } : {}),
  };
};

/**
 * List `/workspace/findings/*.md` from the sandbox container, cat each one,
 * parse YAML frontmatter + filename, and return the structured findings.
 * Optionally filter by `discovered_at >= sinceIso`. Empty array on any
 * error (extraction is best-effort — coord still ends scan cleanly).
 */
export const extractWorkspaceFindings = async (
  options: {
    /** ISO timestamp — only include findings discovered_at-or-after this. */
    readonly sinceIso?: string;
    /** Per-call shell timeout (ms). Default 8s. */
    readonly timeoutMs?: number;
  } = {},
): Promise<DecepticonWorkspaceFinding[]> => {
  const timeoutMs = options.timeoutMs ?? 8000;
  // List finding markdown files (strip directories like findings/evidence/).
  const lsRaw = await runDockerExec(
    ['sh', '-c', `ls -p ${FINDINGS_DIR} 2>/dev/null | grep -v / | grep -i '\\.md$' || true`],
    timeoutMs,
  );
  const filenames = lsRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (filenames.length === 0) return [];
  const sinceMs = options.sinceIso ? Date.parse(options.sinceIso) : 0;
  const out: DecepticonWorkspaceFinding[] = [];
  for (const fn of filenames) {
    // basic safety on filename — no shell metacharacters, only md filenames.
    if (!/^[A-Za-z0-9._-]+\.md$/i.test(fn)) continue;
    const body = await runDockerExec(['cat', `${FINDINGS_DIR}/${fn}`], timeoutMs);
    if (!body) continue;
    const parsed = parseFindingMarkdown(fn, body);
    if (!parsed) continue;
    if (sinceMs > 0) {
      const tsMs = Date.parse(parsed.ts);
      if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
    }
    out.push(parsed);
  }
  return out;
};

/**
 * Wipe the Decepticon workspace before a new scan starts. Best-effort —
 * silent failure if container is missing or path can't be cleared. Without
 * this, a previous scan's findings would leak into the current scan's
 * extraction window (workspace persists across runs in Decepticon).
 */
export const cleanWorkspace = async (timeoutMs = 5000): Promise<void> => {
  await runDockerExec(
    ['sh', '-c', `rm -rf ${WORKSPACE_DIR}/* ${WORKSPACE_DIR}/.[!.]* 2>/dev/null || true`],
    timeoutMs,
  );
};
