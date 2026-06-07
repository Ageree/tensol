import type { Doc } from "../_generated/dataModel";

export function orderToWire(row: Doc<"scanOrders">) {
  return {
    id: row._id,
    user_id: row.userId,
    status: row.status,
    tier: row.tier,
    primary_domain: row.primary_domain,
    attack_surface: row.attack_surface,
    safety_rps: row.safety_rps,
    payment_kind: row.payment_kind === "manual_credit" ? "free_quick" : row.payment_kind,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dns_verify_token: row.dns_verify_token ?? null,
    dns_verified_at: row.dns_verified_at ?? null,
    scan_id: row.scan_id ?? null,
    failure_reason: row.failure_reason ?? null,
    amount_kopecks: row.amount_kopecks ?? null,
  };
}

export function scanToWire(row: Doc<"scans">) {
  return {
    id: row._id,
    user_id: row.userId,
    scan_order_id: row.scan_order_id,
    profile: row.profile,
    status: row.status,
    failure_reason: row.failure_reason ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    usage_tokens: row.usage_tokens ?? null,
    usage_usd_cents: row.usage_usd_cents ?? null,
  };
}

export function eventToWire(row: Doc<"scanEvents">) {
  return {
    id: row._id,
    scan_id: row.scan_id,
    event_type: row.event_type,
    payload: row.payload ?? null,
    created_at: row.created_at,
  };
}

export function findingToWire(row: Doc<"findings">) {
  return {
    id: row._id,
    scan_id: row.scan_id,
    external_id: row.external_id,
    severity: row.severity,
    title: row.title,
    target: row.target,
    cvss_score: row.cvss_score ?? null,
    cvss_vector: row.cvss_vector ?? null,
    cvss_version: row.cvss_version ?? null,
    cwe: row.cwe,
    mitre: row.mitre,
    confidence: row.confidence ?? null,
    phase: row.phase ?? null,
    agent: row.agent ?? null,
    body_md: row.body_md,
    evidence_keys: row.evidence_keys,
    discovered_at: row.discovered_at ?? null,
    created_at: row.created_at,
  };
}
