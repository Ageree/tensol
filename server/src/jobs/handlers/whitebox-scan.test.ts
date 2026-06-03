/**
 * 005-whitebox-mdash — whitebox_scan handler harness-wiring tests.
 * Focused on the decision: deep + harness dep + repoDir → run the harness runner.
 */
import { test, expect } from "bun:test";
import { createWhiteboxScanHandler, type WhiteboxScanHandlerDeps } from "./whitebox-scan.ts";
import type { HarnessRunner, HarnessSession } from "../../review/harness/types.ts";

const repo = {
  id: "repo1",
  owner: "o",
  name: "n",
  scm: "github",
  installationId: null,
  rulesMd: null,
} as never;

function makeDeps(over: {
  mode: "fast" | "deep";
  repoDir?: string;
  harness?: WhiteboxScanHandlerDeps["harness"];
  deepResearchAllowed?: boolean;
}): WhiteboxScanHandlerDeps {
  const review = { id: "r1", status: "queued", repoId: "repo1", commitRef: null, mode: over.mode } as never;
  let finalized = false;
  const service = {
    getReview: async () => review,
    getRepo: async () => repo,
    markReviewRunning: async () => review,
    finalizeReview: async () => {
      finalized = true;
      return review;
    },
    failReview: async () => review,
    _finalized: () => finalized,
  } as never;
  const fetcher = {
    fetch: async () => ({
      files: [{ path: "a.ts", status: "added" as const, contents: "const id = req.query.id; db.query(id);" }],
      ...(over.repoDir !== undefined ? { repoDir: over.repoDir } : {}),
      cleanup: () => {},
    }),
  } as never;
  return {
    service,
    fetcher,
    llm: { complete: async () => JSON.stringify({ summary: "", verdicts: [] }) },
    cloneUrlFor: () => "https://example.com/o/n.git",
    deepResearchAllowed: over.deepResearchAllowed ?? true,
    ...(over.harness ? { harness: over.harness } : {}),
  };
}

const harnessSpy = () => {
  let ran = false;
  const runner: HarnessRunner = {
    run: async () => {
      ran = true;
      return [];
    },
  };
  return {
    harness: {
      makeSession: () => ({}) as unknown as HarnessSession,
      makeRunner: () => runner,
    },
    ran: () => ran,
  };
};

test("deep review with harness dep + repoDir runs the harness runner", async () => {
  const spy = harnessSpy();
  const handler = createWhiteboxScanHandler(makeDeps({ mode: "deep", repoDir: "/tmp/harness-test", harness: spy.harness }));
  await handler("j1", { reviewId: "r1" });
  expect(spy.ran()).toBe(true);
});

test("fast review does NOT run the harness runner", async () => {
  const spy = harnessSpy();
  const handler = createWhiteboxScanHandler(makeDeps({ mode: "fast", repoDir: "/tmp/harness-test", harness: spy.harness }));
  await handler("j2", { reviewId: "r1" });
  expect(spy.ran()).toBe(false);
});

test("deep review WITHOUT repoDir does NOT run the harness runner (no on-disk checkout)", async () => {
  const spy = harnessSpy();
  const handler = createWhiteboxScanHandler(makeDeps({ mode: "deep", harness: spy.harness }));
  await handler("j3", { reviewId: "r1" });
  expect(spy.ran()).toBe(false);
});
