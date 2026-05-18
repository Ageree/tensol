import { describe, it, expect } from "bun:test";
import { now, createClock } from "./time.ts";

describe("now", () => {
  it("returns a sensible unix-ms timestamp", () => {
    const t = now();
    expect(t).toBeGreaterThan(1.7e12);
    expect(t).toBeLessThan(4e12);
  });

  it("is non-decreasing across consecutive calls", () => {
    const a = now();
    const b = now();
    expect(b >= a).toBe(true);
  });
});

describe("createClock", () => {
  it("returns initial value when not advanced", () => {
    const clock = createClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  it("advance moves the clock forward by ms", () => {
    const clock = createClock(1_700_000_000_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_700_000_000_500);
    clock.advance(1);
    expect(clock.now()).toBe(1_700_000_000_501);
  });

  it("autoAdvance increments by 1ms on every now() call", () => {
    const clock = createClock(1_700_000_000_000, true);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_001);
    expect(clock.now()).toBe(1_700_000_000_002);
  });

  it("autoAdvance=false (default) keeps the clock static unless advanced", () => {
    const clock = createClock(42);
    expect(clock.now()).toBe(42);
    expect(clock.now()).toBe(42);
    clock.advance(8);
    expect(clock.now()).toBe(50);
  });
});
