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
const SLUG_TO_TYPE: Record<string, string> = {
  sql: 'sqli',
  xss: 'xss_reflected',
  ssrf: 'ssrf',
  rce: 'rce',
  lfi: 'lfi',
  idor: 'idor',
  csrf: 'csrf',
  xxe: 'xxe',
  ftp: 'info_disclosure',
  exposed: 'info_disclosure',
  hidden: 'info_disclosure',
  unauthenticated: 'broken_auth',
  textbook: 'crypto_weakness',
  poison: 'path_traversal',
  decepticon: 'info_disclosure',
  challenges: 'info_disclosure',
  airtunes: 'info_disclosure',
  sentinel: 'broken_auth',
};

const inferTypeFromSlug = (slug: string): string => {
  const firstWord = slug.split('-')[0]?.toLowerCase() ?? '';
  return SLUG_TO_TYPE[firstWord] ?? 'unknown';
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
  if (!isSeverity(sev)) return null;
  return { severity: sev, slug: noExt.slice(idx + 1) };
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

const parseFindingMarkdown = (
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
  const findingType = inferTypeFromSlug(parts.slug);
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
  return {
    id,
    type: findingType,
    severity,
    ts,
    agent,
    ...(affectedUrl ? { affectedUrl } : {}),
    ...(description ? { description } : {}),
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
