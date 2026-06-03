/**
 * Tests for the PR Review agent tools. A trivial in-memory fake stands in for
 * the GitHub client (structurally compatible with the real `GitHubClient`).
 */
import { expect, test } from "bun:test";
import {
  buildPrAgentTools,
  makeGetPrDiffTool,
  makeReadFileTool,
  type PrToolGitHub,
  type PrToolTarget,
} from "./pr-tools.ts";
import type { DiffFile } from "../../types.ts";

const target: PrToolTarget = { owner: "o", name: "r", pr: 7, ref: "headsha" };

function fakeGh(over: Partial<PrToolGitHub> = {}): PrToolGitHub {
  return {
    async getFileContents() {
      return "file contents";
    },
    async getPullRequestFiles() {
      return [];
    },
    ...over,
  };
}

test("read_file returns the file contents at the pinned ref", async () => {
  let seen: unknown;
  const gh = fakeGh({
    async getFileContents(a) {
      seen = a;
      return "export const x = 1;";
    },
  });
  const tool = makeReadFileTool(gh, target);
  const out = await tool.run({ path: "src/x.ts" });
  expect(out).toBe("export const x = 1;");
  expect(seen).toEqual({ owner: "o", name: "r", path: "src/x.ts", ref: "headsha" });
});

test("read_file reports a clear miss for a non-existent file (no throw)", async () => {
  const gh = fakeGh({ async getFileContents() { return null; } });
  const out = await makeReadFileTool(gh, target).run({ path: "nope.ts" });
  expect(out).toMatch(/file not found: nope\.ts @ headsha/);
});

test("read_file rejects an empty/missing path argument", async () => {
  const tool = makeReadFileTool(fakeGh(), target);
  expect(await tool.run({})).toMatch(/non-empty "path"/);
  expect(await tool.run({ path: "  " })).toMatch(/non-empty "path"/);
});

test("read_file rejects paths that could unpin the ref or escape the repo (security)", async () => {
  let called = false;
  const gh = fakeGh({
    async getFileContents() {
      called = true;
      return "should not reach here";
    },
  });
  const tool = makeReadFileTool(gh, target);
  // Query-injection (would smuggle a second ?ref= and unpin the pinned head SHA).
  expect(await tool.run({ path: "src/x.ts?ref=other-branch" })).toMatch(/ERROR.*path/i);
  // Fragment, backslash, traversal, absolute path.
  expect(await tool.run({ path: "src/x.ts#frag" })).toMatch(/ERROR.*path/i);
  expect(await tool.run({ path: "src\\x.ts" })).toMatch(/ERROR.*path/i);
  expect(await tool.run({ path: "../../etc/passwd" })).toMatch(/ERROR.*path/i);
  expect(await tool.run({ path: "/etc/passwd" })).toMatch(/ERROR.*path/i);
  // None of these reached the GitHub client.
  expect(called).toBe(false);
});

test("read_file allows a normal nested repo-relative path", async () => {
  const gh = fakeGh({ async getFileContents() { return "ok"; } });
  const tool = makeReadFileTool(gh, target);
  // Legitimate paths (including ones with dots in the filename) must pass.
  expect(await tool.run({ path: "src/db/query.service.ts" })).toBe("ok");
});

test("read_file truncates an oversized file with an explicit marker", async () => {
  const gh = fakeGh({ async getFileContents() { return "z".repeat(100_000); } });
  const out = await makeReadFileTool(gh, target).run({ path: "big.ts" });
  expect(out.length).toBeLessThan(100_000);
  expect(out).toMatch(/truncated at 60000 chars/);
});

test("read_file threads the installationId when the target carries one", async () => {
  let seen: any;
  const gh = fakeGh({
    async getFileContents(a) {
      seen = a;
      return "x";
    },
  });
  const tool = makeReadFileTool(gh, { ...target, installationId: "inst-9" });
  await tool.run({ path: "a.ts" });
  expect(seen.installationId).toBe("inst-9");
});

const diffFiles: DiffFile[] = [
  { path: "a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
  { path: "b.ts", status: "added", patch: "@@ +1 @@\n+added" },
];

test("get_pr_diff returns all changed files' hunks by default", async () => {
  const gh = fakeGh({ async getPullRequestFiles() { return diffFiles; } });
  const out = await makeGetPrDiffTool(gh, target).run({});
  expect(out).toContain("### a.ts (modified)");
  expect(out).toContain("### b.ts (added)");
  expect(out).toContain("+new");
});

test("get_pr_diff filters to a single path when given one", async () => {
  const gh = fakeGh({ async getPullRequestFiles() { return diffFiles; } });
  const out = await makeGetPrDiffTool(gh, target).run({ path: "a.ts" });
  expect(out).toContain("### a.ts");
  expect(out).not.toContain("### b.ts");
});

test("get_pr_diff reports a clean message for a path that didn't change", async () => {
  const gh = fakeGh({ async getPullRequestFiles() { return diffFiles; } });
  const out = await makeGetPrDiffTool(gh, target).run({ path: "c.ts" });
  expect(out).toMatch(/no changed file at c\.ts/);
});

test("get_pr_diff handles a file with no textual patch", async () => {
  const gh = fakeGh({
    async getPullRequestFiles() {
      return [{ path: "img.png", status: "added" }];
    },
  });
  const out = await makeGetPrDiffTool(gh, target).run({});
  expect(out).toMatch(/no textual diff/);
});

test("buildPrAgentTools exposes read_file and get_pr_diff", () => {
  const tools = buildPrAgentTools(fakeGh(), target);
  expect(tools.map((t) => t.spec.name).sort()).toEqual(["get_pr_diff", "read_file"]);
});
