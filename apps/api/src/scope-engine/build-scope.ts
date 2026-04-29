// Sprint 6 — load EffectiveScope for an assessment from DB.
//
// Pure-ish: DB I/O happens here, NOT in the engine package. The engine
// receives a fully-built `EffectiveScope` and the injected DnsResolver/Clock/
// RateLimitCounter; it does no I/O of its own.

import type { Database } from '@cyberstrike/db';
import {
  type AssessmentFlags,
  DEFAULT_PLATFORM_POLICY,
  type EffectiveScope,
  type TimeWindow,
  type ToolCategory,
  buildEffectiveScope,
  normalizeHost,
  normalizeUrl,
} from '@cyberstrike/scope-engine';
import type { Kysely } from 'kysely';
import { STATIC_TOOL_CATALOG } from './tool-catalog.ts';

/**
 * codex iter-4 P1 — canonicalize a stored target value (`targets.value`) to
 * the same form `normalizeAction` produces for action targets. Returns ALL
 * canonical representations (lowercase raw, canonical URL, canonical host)
 * so action targets in either form match. Empty string filtered out.
 */
const canonicalRefsFromTargetValue = (kind: string, value: string): readonly string[] => {
  const refs = new Set<string>();
  const lower = String(value).toLowerCase().trim();
  if (lower.length > 0) refs.add(lower);
  if (kind === 'url' || lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const u = normalizeUrl(value);
      refs.add(u.canonical);
      refs.add(u.host);
    } catch {
      /* not parseable as URL; lowercase raw retained */
    }
  }
  if (kind === 'domain' || kind === 'ip') {
    try {
      const h = normalizeHost(value);
      refs.add(h.canonical);
    } catch {
      /* not a valid hostname; lowercase raw retained */
    }
  }
  return [...refs];
};

interface AssessmentRow {
  id: string;
  tenant_id: string;
  state: string;
  testing_window_start: Date | null;
  testing_window_end: Date | null;
  high_impact_categories: unknown;
}

/**
 * Build the effective scope for an assessment from DB. Caller has already
 * validated tenant ownership via `assertOwnership`.
 *
 * Returns null if the assessment is not found.
 */
export const buildScopeForAssessment = async (
  db: Kysely<Database>,
  assessmentId: string,
): Promise<EffectiveScope | null> => {
  const assessment = (await db
    .selectFrom('assessments')
    .select([
      'id',
      'tenant_id',
      'state',
      'testing_window_start',
      'testing_window_end',
      'high_impact_categories',
    ])
    .where('id', '=', assessmentId)
    .executeTakeFirst()) as AssessmentRow | undefined;
  if (!assessment) return null;

  const ruleRows = await db
    .selectFrom('assessment_scope_rules')
    .select(['id', 'rule_kind', 'effect', 'payload'])
    .where('tenant_id', '=', assessment.tenant_id)
    .where('assessment_id', '=', assessment.id)
    .execute();

  // Verified-target IDs (the engine's high-impact gate consults this set).
  // Also collect canonical target-ref values (host/IP/url/cidr 'value' column)
  // so the engine can enforce per-target verification on tool_invoke actions
  // whose targetRef maps to an assessment target (codex P1).
  const verifiedTargetRows = await db
    .selectFrom('assessment_targets as at')
    .innerJoin('targets as t', (join) =>
      join.onRef('t.id', '=', 'at.target_id').onRef('t.tenant_id', '=', 'at.tenant_id'),
    )
    .select(['t.id as target_id', 't.ownership_status', 't.kind', 't.value'])
    .where('at.tenant_id', '=', assessment.tenant_id)
    .where('at.assessment_id', '=', assessment.id)
    .execute();
  const ownershipVerifiedTargetIds = new Set<string>(
    verifiedTargetRows.filter((r) => r.ownership_status === 'verified').map((r) => r.target_id),
  );
  // codex iter-10 P1 — ID-keyed sets for the all-targets-verified gate.
  // Two targets that canonicalize to the same ref (e.g. URL + matching-host
  // domain) would dedupe in a Set<ref> and silently mask an unverified
  // target. Distinct IDs keep the count honest.
  const assessmentTargetIds = new Set<string>(verifiedTargetRows.map((r) => r.target_id));
  const verifiedTargetIds = new Set<string>(
    verifiedTargetRows.filter((r) => r.ownership_status === 'verified').map((r) => r.target_id),
  );
  const assessmentTargetRefs = new Set<string>();
  const verifiedTargetRefs = new Set<string>();
  for (const r of verifiedTargetRows) {
    const refs = canonicalRefsFromTargetValue(String(r.kind), String(r.value));
    for (const ref of refs) {
      assessmentTargetRefs.add(ref);
      if (r.ownership_status === 'verified') verifiedTargetRefs.add(ref);
    }
  }

  // High-impact categories — JSONB array (could be string array or array-of-strings).
  const highImpactCategories = (() => {
    const raw = assessment.high_impact_categories;
    if (!Array.isArray(raw)) return [] as ToolCategory[];
    return raw.filter((v): v is ToolCategory =>
      ['c2', 'post_exploit', 'ad', 'credential_audit', 'recon', 'web', 'cloud'].includes(String(v)),
    );
  })();

  const assessmentFlags: AssessmentFlags = {
    highImpactCategories,
    ownershipVerifiedTargetIds,
    assessmentTargetRefs,
    verifiedTargetRefs,
    assessmentTargetIds,
    verifiedTargetIds,
  };

  const timeWindow: TimeWindow | null =
    assessment.testing_window_start && assessment.testing_window_end
      ? {
          start: new Date(assessment.testing_window_start).toISOString(),
          end: new Date(assessment.testing_window_end).toISOString(),
        }
      : null;

  return buildEffectiveScope({
    tenantId: assessment.tenant_id,
    assessmentId: assessment.id,
    tenantPolicy: { tenantId: assessment.tenant_id },
    platformPolicy: DEFAULT_PLATFORM_POLICY,
    rawRules: ruleRows.map((r) => ({
      id: r.id,
      ruleKind: r.rule_kind,
      effect: r.effect as 'allow' | 'deny',
      payload:
        typeof r.payload === 'object' && r.payload !== null
          ? (r.payload as Record<string, unknown>)
          : {},
    })),
    toolCatalog: STATIC_TOOL_CATALOG,
    assessmentFlags,
    timeWindow,
  });
};

export interface AssessmentTerminalState {
  readonly id: string;
  readonly state: string;
  readonly tenantId: string;
}

/** Fast helper: returns assessment id+state+tenant for the route's IDOR/terminal check. */
export const loadAssessmentMeta = async (
  db: Kysely<Database>,
  assessmentId: string,
): Promise<AssessmentTerminalState | null> => {
  const row = await db
    .selectFrom('assessments')
    .select(['id', 'tenant_id', 'state'])
    .where('id', '=', assessmentId)
    .executeTakeFirst();
  return row ? { id: row.id, state: row.state, tenantId: row.tenant_id } : null;
};
