/**
 * Time primitives. `now()` is the default real-clock injection point.
 * For tests, use `createClock(initialMs, autoAdvance?)` to get a deterministic clock.
 */

export function now(): number {
  return Date.now();
}

export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

/**
 * Create a fake clock for tests.
 *
 * @param initialMs starting unix ms
 * @param autoAdvance if true, every `now()` call also advances the clock by 1ms
 */
export function createClock(initialMs: number, autoAdvance = false): Clock {
  let current = initialMs;
  return {
    now: () => {
      const t = current;
      if (autoAdvance) current += 1;
      return t;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}
