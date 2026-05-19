import { describe, test, expect } from "bun:test";
import {
  canTransition,
  nextStateOnEvent,
  isTerminalState,
  SCAN_ORDER_STATES,
  SCAN_ORDER_EVENTS,
  TERMINAL_STATES,
  type ScanOrderState,
  type ScanOrderEvent,
} from "./lifecycle";
import { ScanOrderStatusEnum } from "../schemas/scan-orders";

/**
 * T029 — exhaustive transition-matrix tests for the scan_orders state
 * machine.
 *
 * Authority:
 *   - `specs/002-blackbox-mvp/data-model.md` §E2 state machine (lines 87–107)
 *   - `server/src/schemas/scan-orders.ts` `ScanOrderStatusEnum` (8 states)
 *
 * Strategy:
 *   - Build the authoritative `VALID_TRANSITIONS` table inline (single
 *     source of truth for the test suite).
 *   - Verify the table covers every transition listed in data-model.md
 *     §E2 by enumerating arrows manually below in `EXPECTED_ARROWS`.
 *   - Exhaustively probe all N² (state, state) pairs to confirm every
 *     valid pair returns `true` and every illegal pair returns `false`.
 *   - Walk every (state, event) pair to confirm `nextStateOnEvent`
 *     returns the documented target state or `null`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative tables (derived from data-model.md §E2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every legal `from → to` arrow, transcribed from data-model.md §E2
 * (lines 87–107). If this table drifts from the spec, the spec wins.
 *
 * Reading guide:
 *   draft       → dns_pending       (POST /dns-verify/request)
 *   draft       → cancelled         (DELETE within draft)
 *   dns_pending → dns_verified      (resolveTxtAgreed success)
 *   dns_pending → failed            (30-min timeout)
 *   dns_pending → cancelled         (DELETE)
 *   dns_verified → vm_provisioning  (POST /launch)
 *   dns_verified → cancelled        (DELETE)
 *   vm_provisioning → running       (spawnVm + pollOperation success)
 *   vm_provisioning → failed        (spawnVm failure after 3 retries)
 *   vm_provisioning → cancelled     (DELETE)
 *   running     → completed         (webhook scan-complete)
 *   running     → failed            (90-min wall-clock timeout)
 *   running     → cancelled         (DELETE)
 */
const VALID_TRANSITIONS: ReadonlyArray<[ScanOrderState, ScanOrderState]> = [
  ["draft", "dns_pending"],
  ["draft", "cancelled"],
  ["dns_pending", "dns_verified"],
  ["dns_pending", "failed"],
  ["dns_pending", "cancelled"],
  ["dns_verified", "vm_provisioning"],
  ["dns_verified", "cancelled"],
  ["vm_provisioning", "running"],
  ["vm_provisioning", "failed"],
  ["vm_provisioning", "cancelled"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
];

/**
 * Event → resulting state map per state. Events are derived from the
 * arrow labels in data-model.md §E2; each event uniquely determines
 * its target state and is only applicable from specific origin states.
 *
 * `dns_verify_requested`     : draft        → dns_pending
 * `dns_verified`             : dns_pending  → dns_verified
 * `dns_timeout`              : dns_pending  → failed
 * `launch_requested`         : dns_verified → vm_provisioning
 * `vm_ready`                 : vm_provisioning → running
 * `vm_spawn_failed`          : vm_provisioning → failed
 * `scan_completed`           : running      → completed
 * `scan_timeout`             : running      → failed
 * `cancelled`                : draft | dns_pending | dns_verified |
 *                              vm_provisioning | running → cancelled
 */
const EVENT_OUTCOMES: ReadonlyArray<
  readonly [ScanOrderEvent, ScanOrderState, ScanOrderState]
> = [
  ["dns_verify_requested", "draft", "dns_pending"],
  ["dns_verified", "dns_pending", "dns_verified"],
  ["dns_timeout", "dns_pending", "failed"],
  ["launch_requested", "dns_verified", "vm_provisioning"],
  ["vm_ready", "vm_provisioning", "running"],
  ["vm_spawn_failed", "vm_provisioning", "failed"],
  ["scan_completed", "running", "completed"],
  ["scan_timeout", "running", "failed"],
  ["cancelled", "draft", "cancelled"],
  ["cancelled", "dns_pending", "cancelled"],
  ["cancelled", "dns_verified", "cancelled"],
  ["cancelled", "vm_provisioning", "cancelled"],
  ["cancelled", "running", "cancelled"],
];

const EXPECTED_TERMINALS: ReadonlyArray<ScanOrderState> = [
  "completed",
  "failed",
  "cancelled",
];

// ─────────────────────────────────────────────────────────────────────────────
// Self-consistency between the lifecycle module and the Zod enum
// ─────────────────────────────────────────────────────────────────────────────

describe("SCAN_ORDER_STATES (enum parity)", () => {
  test("matches ScanOrderStatusEnum 1:1 (no drift between lifecycle and zod)", () => {
    expect([...SCAN_ORDER_STATES].sort()).toEqual(
      [...ScanOrderStatusEnum.options].sort(),
    );
  });

  test("contains all 8 documented states", () => {
    expect(SCAN_ORDER_STATES.length).toBe(8);
  });

  test("contains exactly the expected terminal states", () => {
    expect(([...TERMINAL_STATES] as ScanOrderState[]).sort()).toEqual(
      [...EXPECTED_TERMINALS].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canTransition — exhaustive N² matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("canTransition — valid arrows", () => {
  test.each(VALID_TRANSITIONS.map(([f, t]) => [f, t]))(
    "allows %s → %s",
    (from, to) => {
      expect(canTransition(from as ScanOrderState, to as ScanOrderState)).toBe(
        true,
      );
    },
  );

  test("exactly 13 valid transitions", () => {
    expect(VALID_TRANSITIONS.length).toBe(13);
  });
});

describe("canTransition — illegal arrows (N² − valid)", () => {
  // Compute the illegal set: every (from, to) pair NOT in VALID_TRANSITIONS,
  // including same-state self-loops which the data-model does NOT permit.
  const validSet = new Set(VALID_TRANSITIONS.map(([f, t]) => `${f}→${t}`));
  const illegalPairs: Array<[ScanOrderState, ScanOrderState]> = [];
  for (const from of SCAN_ORDER_STATES) {
    for (const to of SCAN_ORDER_STATES) {
      if (!validSet.has(`${from}→${to}`)) {
        illegalPairs.push([from, to]);
      }
    }
  }

  test("matrix size: N² = 64 pairs total, 13 valid, 51 illegal", () => {
    expect(SCAN_ORDER_STATES.length * SCAN_ORDER_STATES.length).toBe(64);
    expect(illegalPairs.length).toBe(64 - VALID_TRANSITIONS.length);
    expect(illegalPairs.length).toBe(51);
  });

  test.each(illegalPairs)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe("canTransition — terminal states are sinks", () => {
  test.each(EXPECTED_TERMINALS.flatMap((t) => SCAN_ORDER_STATES.map((s) => [t, s])))(
    "%s has no outgoing transition (→ %s)",
    (from, to) => {
      expect(canTransition(from as ScanOrderState, to as ScanOrderState)).toBe(
        false,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// nextStateOnEvent — full event × state matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("nextStateOnEvent — valid (event, state) pairs", () => {
  test.each(EVENT_OUTCOMES.map(([e, s, r]) => [e, s, r]))(
    "event %s in state %s → %s",
    (event, from, expected) => {
      expect(
        nextStateOnEvent(from as ScanOrderState, event as ScanOrderEvent),
      ).toBe(expected as ScanOrderState);
    },
  );

  test("EVENT_OUTCOMES is exhaustive (13 documented arrows)", () => {
    // 8 deterministic arrows + 5 cancellation arrows = 13, same count as
    // VALID_TRANSITIONS because every arrow has a triggering event.
    expect(EVENT_OUTCOMES.length).toBe(VALID_TRANSITIONS.length);
  });
});

describe("nextStateOnEvent — invalid (event, state) pairs return null", () => {
  const validKeys = new Set(EVENT_OUTCOMES.map(([e, s]) => `${e}@${s}`));
  const invalidPairs: Array<[ScanOrderEvent, ScanOrderState]> = [];
  for (const event of SCAN_ORDER_EVENTS) {
    for (const state of SCAN_ORDER_STATES) {
      if (!validKeys.has(`${event}@${state}`)) {
        invalidPairs.push([event, state]);
      }
    }
  }

  test("matrix size: 9 events × 8 states = 72 pairs, 13 valid, 59 invalid", () => {
    expect(SCAN_ORDER_EVENTS.length).toBe(9);
    expect(SCAN_ORDER_STATES.length * SCAN_ORDER_EVENTS.length).toBe(72);
    expect(invalidPairs.length).toBe(72 - EVENT_OUTCOMES.length);
    expect(invalidPairs.length).toBe(59);
  });

  test.each(invalidPairs)("event %s in state %s returns null", (event, state) => {
    expect(nextStateOnEvent(state, event)).toBeNull();
  });
});

describe("nextStateOnEvent — terminal states emit nothing", () => {
  test.each(
    EXPECTED_TERMINALS.flatMap((s) =>
      SCAN_ORDER_EVENTS.map((e) => [s, e]),
    ),
  )("state %s + event %s → null", (state, event) => {
    expect(
      nextStateOnEvent(state as ScanOrderState, event as ScanOrderEvent),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isTerminalState helper
// ─────────────────────────────────────────────────────────────────────────────

describe("isTerminalState", () => {
  test.each(EXPECTED_TERMINALS.map((s) => [s] as const))(
    "returns true for terminal state %s",
    (s) => {
      expect(isTerminalState(s)).toBe(true);
    },
  );

  test.each(
    SCAN_ORDER_STATES.filter(
      (s) => !EXPECTED_TERMINALS.includes(s as ScanOrderState),
    ).map((s) => [s] as const),
  )("returns false for non-terminal state %s", (s) => {
    expect(isTerminalState(s)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reachability invariant — every non-terminal must have ≥ 1 outgoing arrow
// ─────────────────────────────────────────────────────────────────────────────

describe("graph invariants", () => {
  test("every non-terminal state has ≥ 1 outgoing transition", () => {
    const nonTerminals = SCAN_ORDER_STATES.filter(
      (s) => !EXPECTED_TERMINALS.includes(s as ScanOrderState),
    );
    for (const state of nonTerminals) {
      const outgoing = VALID_TRANSITIONS.filter(([f]) => f === state);
      expect(outgoing.length).toBeGreaterThan(0);
    }
  });

  test("every non-terminal state can reach 'cancelled' in one step", () => {
    const nonTerminals = SCAN_ORDER_STATES.filter(
      (s) => !EXPECTED_TERMINALS.includes(s as ScanOrderState),
    );
    for (const state of nonTerminals) {
      expect(canTransition(state as ScanOrderState, "cancelled")).toBe(true);
    }
  });
});
