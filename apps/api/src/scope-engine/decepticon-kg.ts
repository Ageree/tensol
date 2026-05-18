// Phase 3.1 sub-commit 3 (2026-05-12) — Neo4j knowledge-graph extractor.
//
// After Decepticon's verifier agent runs (start-decepticon-session.ts
// step 8.7), it writes FINDING nodes to Neo4j with a VALIDATES edge
// pointing at the source VULNERABILITY node. This module reads those
// validated FINDING nodes back into Tensol so step 8.8 can promote them
// from `candidate_findings` to the `findings` table.
//
// Transport: Neo4j HTTP API at port 7474 (Bun's native fetch). We
// deliberately avoid the bolt driver / cypher-shell here — fetch is
// dependency-free and cypher-shell only emits CSV/plain which would
// need custom parsing.

const DEFAULT_NEO4J_HTTP_URL = 'http://localhost:7474';
const DEFAULT_NEO4J_USER = 'neo4j';
const DEFAULT_NEO4J_PASSWORD = 'decepticon-graph';
const DEFAULT_NEO4J_DATABASE = 'neo4j';

/**
 * Shape of a verifier-validated finding extracted from the Neo4j kg.
 *
 * `findingProps` and `vulnProps` are parsed from Decepticon's `props`
 * JSON-string columns — Decepticon stores all node attributes as a
 * single serialized JSON blob rather than first-class Neo4j props.
 */
export interface KgValidatedFinding {
  /** Decepticon-internal stable id for the FINDING node, e.g. "f3296e51d0589446". */
  readonly findingId: string;
  /** Human-readable finding label, e.g. "SQL injection in /products?id=". */
  readonly findingLabel: string;
  /** Decepticon-internal canonical key, e.g. "FIND-001". */
  readonly findingKey: string;
  /** Parsed JSON props on the FINDING node — verifier-emitted PoC, evidence, etc. */
  readonly findingProps: Record<string, unknown>;
  /** Parsed JSON props on the connected VULNERABILITY node — original recon claim. */
  readonly vulnProps: Record<string, unknown>;
  /** Human-readable vulnerability label, e.g. "DVWA Command Injection". */
  readonly vulnLabel: string;
  /** Decepticon-internal canonical key for the VULNERABILITY node. */
  readonly vulnKey: string;
  /** Unix-seconds timestamp (float) when the FINDING node was last updated. */
  readonly validatedAt: number;
}

/**
 * Options accepted by {@link queryValidatedFindings}. All optional; the
 * defaults read Decepticon's local docker-compose Neo4j service.
 */
export interface QueryValidatedFindingsOptions {
  /** Lower bound on the FINDING node's `created_at` (Unix seconds, float). */
  readonly sinceUnixSeconds?: number;
  /** Override of the Neo4j HTTP URL (default `http://localhost:7474`). */
  readonly neo4jUrl?: string;
  /** Override of the Neo4j Basic-auth username. */
  readonly user?: string;
  /** Override of the Neo4j Basic-auth password. */
  readonly password?: string;
  /** Override of the Neo4j database name. */
  readonly database?: string;
}

/**
 * Read all verifier-validated FINDING nodes from the engagement
 * knowledge graph. A "verifier-validated" finding is any FINDING node
 * connected to a Vulnerability via a `[:VALIDATES]` edge (the canonical
 * shape Decepticon's verifier agent writes via `validate_finding`).
 *
 * Best-effort: returns an empty array on any transport error so the
 * caller (step 8.8) can degrade gracefully — candidate_findings still
 * ship, just without `findings` promotion.
 */
export const queryValidatedFindings = async (
  options: QueryValidatedFindingsOptions = {},
): Promise<KgValidatedFinding[]> => {
  const env = process.env as Record<string, string | undefined>;
  const url = options.neo4jUrl ?? env['NEO4J_HTTP_URL'] ?? DEFAULT_NEO4J_HTTP_URL;
  const user = options.user ?? env['NEO4J_USER'] ?? DEFAULT_NEO4J_USER;
  const password = options.password ?? env['NEO4J_PASSWORD'] ?? DEFAULT_NEO4J_PASSWORD;
  const database = options.database ?? env['NEO4J_DATABASE'] ?? DEFAULT_NEO4J_DATABASE;
  const sinceUnixSeconds = options.sinceUnixSeconds ?? 0;

  const endpoint = `${url.replace(/\/$/, '')}/db/${database}/tx/commit`;

  // Cypher returns one row per (FINDING, VULNERABILITY) validated pair.
  // Verifier writes BOTH "validated: <label>" AND "rejected: <label>"
  // FINDING nodes with VALIDATES edges (a "rejected" finding means the
  // verifier ran a PoC that failed → false positive on the source vuln).
  // Phase 3.1 sub-commit 7 (2026-05-12): filter to only "validated:"
  // prefixed labels — those are the bugs we should promote to findings.
  // ORDER BY findingId ensures deterministic ingestion order.
  const cypher = `
    MATCH (f:Finding)-[:VALIDATES]->(v:Vulnerability)
    WHERE f.created_at >= $since
      AND f.label STARTS WITH 'validated:'
    RETURN f.id AS findingId,
           f.label AS findingLabel,
           f.key AS findingKey,
           f.props AS findingProps,
           f.updated_at AS validatedAt,
           v.label AS vulnLabel,
           v.key AS vulnKey,
           v.props AS vulnProps
    ORDER BY f.id ASC
  `.trim();

  const body = JSON.stringify({
    statements: [{ statement: cypher, parameters: { since: sinceUnixSeconds } }],
  });

  const basic = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  type Neo4jRow = {
    readonly row?: ReadonlyArray<unknown>;
  };
  type Neo4jResult = {
    readonly columns?: ReadonlyArray<string>;
    readonly data?: ReadonlyArray<Neo4jRow>;
  };
  type Neo4jEnvelope = {
    readonly results?: ReadonlyArray<Neo4jResult>;
    readonly errors?: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  };

  let parsed: Neo4jEnvelope;
  try {
    parsed = (await response.json()) as Neo4jEnvelope;
  } catch {
    return [];
  }
  if (parsed.errors && parsed.errors.length > 0) return [];

  const result = parsed.results?.[0];
  if (!result?.data) return [];

  const findings: KgValidatedFinding[] = [];
  for (const row of result.data) {
    const values = row.row;
    if (!values || values.length < 8) continue;
    const findingId = String(values[0] ?? '');
    const findingLabel = String(values[1] ?? '');
    const findingKey = String(values[2] ?? '');
    const findingPropsRaw = values[3];
    const validatedAtRaw = values[4];
    const vulnLabel = String(values[5] ?? '');
    const vulnKey = String(values[6] ?? '');
    const vulnPropsRaw = values[7];

    if (!findingId) continue;

    const findingProps = safeParseJson(findingPropsRaw);
    const vulnProps = safeParseJson(vulnPropsRaw);
    const validatedAt = typeof validatedAtRaw === 'number' ? validatedAtRaw : 0;

    findings.push({
      findingId,
      findingLabel,
      findingKey,
      findingProps,
      vulnProps,
      vulnLabel,
      vulnKey,
      validatedAt,
    });
  }
  return findings;
};

/**
 * Phase 3.1 sub-commit 4 (2026-05-12) — count Vulnerability nodes
 * written during this engagement, used by step 8.7 to decide whether to
 * dispatch the verifier. Decouples the gate from Tensol-side
 * candidate_findings count (which depends on workspace markdown
 * extraction, a fragile schema-dependent path). The kg is the canonical
 * signal: if recon wrote any `kind="vulnerability"` nodes via Rule 4b,
 * verifier should attempt validation.
 *
 * Returns 0 on transport error so the caller degrades gracefully.
 */
export const queryVulnerabilityCount = async (
  options: QueryValidatedFindingsOptions = {},
): Promise<number> => {
  const env = process.env as Record<string, string | undefined>;
  const url = options.neo4jUrl ?? env['NEO4J_HTTP_URL'] ?? DEFAULT_NEO4J_HTTP_URL;
  const user = options.user ?? env['NEO4J_USER'] ?? DEFAULT_NEO4J_USER;
  const password = options.password ?? env['NEO4J_PASSWORD'] ?? DEFAULT_NEO4J_PASSWORD;
  const database = options.database ?? env['NEO4J_DATABASE'] ?? DEFAULT_NEO4J_DATABASE;
  const sinceUnixSeconds = options.sinceUnixSeconds ?? 0;

  const endpoint = `${url.replace(/\/$/, '')}/db/${database}/tx/commit`;
  const cypher = `
    MATCH (v:Vulnerability)
    WHERE v.created_at >= $since
    RETURN count(v) AS n
  `.trim();

  const body = JSON.stringify({
    statements: [{ statement: cypher, parameters: { since: sinceUnixSeconds } }],
  });
  const basic = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
  } catch {
    return 0;
  }
  if (!response.ok) return 0;

  type Neo4jEnvelope = {
    readonly results?: ReadonlyArray<{
      readonly data?: ReadonlyArray<{ readonly row?: ReadonlyArray<unknown> }>;
    }>;
  };
  let parsed: Neo4jEnvelope;
  try {
    parsed = (await response.json()) as Neo4jEnvelope;
  } catch {
    return 0;
  }
  const row = parsed.results?.[0]?.data?.[0]?.row;
  const n = row?.[0];
  return typeof n === 'number' ? n : 0;
};

const safeParseJson = (raw: unknown): Record<string, unknown> => {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const out = JSON.parse(raw) as unknown;
    if (out && typeof out === 'object' && !Array.isArray(out)) return out as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
};
