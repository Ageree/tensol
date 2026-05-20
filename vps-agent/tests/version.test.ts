import { test, expect } from "bun:test";
import { VPS_AGENT_VERSION } from "../src/version";

test("version is semver-ish", () => {
  expect(VPS_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
