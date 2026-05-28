/**
 * T028 — pure state-machine helpers for `scan_orders`.
 *
 * Source of truth:
 *   - `specs/002-blackbox-mvp/data-model.md` §E2 state machine (lines 87–107)
 *   - `server/src/schemas/scan-orders.ts` `ScanOrderStatusEnum`
 *
 * Design constraints:
 *   - Pure functions only — no DB, no IO, no logging, no clock access.
 *     Callers (the scan-orders service in T034+) are responsible for
 *     persisting transitions and emitting the signed audit events
 *     required by data-model.md §E11.
 *   - State and event names are frozen tuples (`as const`) so TypeScript
 *     can narrow them and the compiler enforces exhaustive switches at
 *     call sites.
 *   - The state set is asserted equal to `ScanOrderStatusEnum.options`
 *     in `lifecycle.test.ts` to prevent silent drift.
 *
 * Why a transition TABLE (rather than a switch):
 *   - Easy to enumerate exhaustively in tests (`Object.entries(ALLOWED)`).
 *   - Easy to grep for "what can become X" when triaging bugs.
 *   - The runtime cost is identical to a switch after JIT inlining.
 *
 * Why separate `canTransition` and `nextStateOnEvent`:
 *   - `canTransition(from, to)` answers a structural question
 *     ("is this arrow in the graph?") used by guards and tests.
 *   - `nextStateOnEvent(state, event)` answers a behavioural question
 *     ("given a stimulus, where do I go?") used by route handlers and
 *     cron watchers. Events are richer than (from, to) pairs because a
 *     single arrow can have multiple triggering events (e.g. `failed`
 *     from `dns_pending` via `dns_timeout` is distinct from `failed`
 *     from `vm_provisioning` via `vm_spawn_failed`).
 */

// ─────────────────────────────────────────────────────────────────────────────
// States
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All `scan_orders.status` values, in wizard progression order.
 *
 * MUST stay in sync with `ScanOrderStatusEnum` in
 * `server/src/schemas/scan-orders.ts` — drift is caught by
 * `lifecycle.test.ts`'s "enum parity" assertion.
 */
export const SCAN_ORDER_STATES = [
  "draft",
  "dns_pending",
  "dns_verified",
  "vm_provisioning",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ScanOrderState = (typeof SCAN_ORDER_STATES)[number];

/**
 * Terminal states — once entered, the row never transitions again.
 * Per data-model.md §E2, no outgoing arrows are listed for any of
 * `completed`, `failed`, or `cancelled`.
 */
export const TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

export type TerminalScanOrderState = (typeof TERMINAL_STATES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle events derived from the arrow labels in data-model.md §E2.
 *
 * Naming uses past-tense verbs ("dns_verified") for events that report
 * an outcome, and imperative-ish nouns ("dns_verify_requested") for
 * events that mark a user-initiated action. This mirrors the language
 * used in the spec arrows.
 *
 * `cancelled` is the only event applicable from multiple origin states
 * (any non-terminal state can be cancelled via DELETE /scan-orders/:id).
 */
export const SCAN_ORDER_EVENTS = [
  "dns_verify_requested",
  "dns_verified",
  "dns_timeout",
  "launch_requested",
  "vm_ready",
  "vm_spawn_failed",
  "scan_completed",
  "scan_timeout",
  "cancelled",
] as const;

export type ScanOrderEvent = (typeof SCAN_ORDER_EVENTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Transition table (state → list of legal next states)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ALLOWED[from]` enumerates every state reachable from `from` in one
 * step. Empty arrays mark terminal states.
 *
 * Built from data-model.md §E2 (lines 87–107) — every arrow there has
 * a corresponding entry below; no extras.
 */
const ALLOWED: Readonly<Record<ScanOrderState, ReadonlyArray<ScanOrderState>>> = {
  draft: ["dns_pending", "cancelled"],
  dns_pending: ["dns_verified", "failed", "cancelled"],
  dns_verified: ["vm_provisioning", "cancelled"],
  vm_provisioning: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  // Terminals — no outgoing arrows.
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * `true` if `from → to` is a legal one-step transition in the
 * scan-orders state machine, `false` otherwise (including self-loops
 * and any move out of a terminal state).
 *
 * Pure; safe to call from anywhere.
 */
export function canTransition(
  from: ScanOrderState,
  to: ScanOrderState,
): boolean {
  return ALLOWED[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event → next-state map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For each event, the partial map `currentState → resultingState`.
 *
 * If an event is applied to a state it does not apply to, the lookup
 * yields `undefined` and `nextStateOnEvent` returns `null` (callers
 * MUST treat this as an illegal transition).
 *
 * Cancellation is special: every non-terminal state can be cancelled,
 * so the `cancelled` event maps each of them to `cancelled`.
 */
const EVENT_TRANSITIONS: Readonly<
  Record<ScanOrderEvent, Readonly<Partial<Record<ScanOrderState, ScanOrderState>>>>
> = {
  dns_verify_requested: { draft: "dns_pending" },
  dns_verified: { dns_pending: "dns_verified" },
  dns_timeout: { dns_pending: "failed" },
  launch_requested: { dns_verified: "vm_provisioning" },
  vm_ready: { vm_provisioning: "running" },
  vm_spawn_failed: { vm_provisioning: "failed" },
  scan_completed: { running: "completed" },
  scan_timeout: { running: "failed" },
  cancelled: {
    draft: "cancelled",
    dns_pending: "cancelled",
    dns_verified: "cancelled",
    vm_provisioning: "cancelled",
    running: "cancelled",
  },
};

/**
 * Returns the state that results from applying `event` while in
 * `state`, or `null` if the event does not apply.
 *
 * Pure; safe to call from anywhere. Callers (route handlers, cron
 * watchers) should treat `null` as "ignore the event" or "reject the
 * request" depending on context.
 */
export function nextStateOnEvent(
  state: ScanOrderState,
  event: ScanOrderEvent,
): ScanOrderState | null {
  const next = EVENT_TRANSITIONS[event][state];
  return next ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `true` if `state` is terminal (no outgoing arrows).
 *
 * Convenience helper that mirrors `TERMINAL_STATES.includes(state)`
 * but narrows the type for downstream `switch` statements.
 */
export function isTerminalState(
  state: ScanOrderState,
): state is TerminalScanOrderState {
  return (TERMINAL_STATES as readonly ScanOrderState[]).includes(state);
}
