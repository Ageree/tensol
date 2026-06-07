import { test, expect, beforeEach, afterEach } from "bun:test";
import { isYookassaLive } from "./feature-flags.ts";

// Legacy compatibility tests for the pre-2026-06-05 paid flag. New billing
// work should add provider-agnostic flags instead of extending this helper.
const ORIG = process.env.TENSOL_YOOKASSA_LIVE;

beforeEach(() => {
  delete process.env.TENSOL_YOOKASSA_LIVE;
});

afterEach(() => {
  if (ORIG !== undefined) {
    process.env.TENSOL_YOOKASSA_LIVE = ORIG;
  } else {
    delete process.env.TENSOL_YOOKASSA_LIVE;
  }
});

test("isYookassaLive returns false when env var is unset", () => {
  expect(isYookassaLive()).toBe(false);
});

test("isYookassaLive returns false when env var is 'false' or '1'", () => {
  process.env.TENSOL_YOOKASSA_LIVE = "false";
  expect(isYookassaLive()).toBe(false);
  process.env.TENSOL_YOOKASSA_LIVE = "1";
  expect(isYookassaLive()).toBe(false);
});

test("isYookassaLive returns true only when env var === 'true'", () => {
  process.env.TENSOL_YOOKASSA_LIVE = "true";
  expect(isYookassaLive()).toBe(true);
});
