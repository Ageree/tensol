import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRepoAgentTools,
  createFsRepoCapabilities,
  type RepoToolCapabilities,
} from "./repo-tools.ts";

const caps = (over: Partial<RepoToolCapabilities> = {}): RepoToolCapabilities => ({
  repoDir: "/repo",
  readFile: async (p) => (p === "src/a.ts" ? "export const x = 1;" : null),
  listFiles: async () => ["src/a.ts", "src/b.ts"],
  grep: async (pat) => (pat === "eval" ? ["src/b.ts:4: eval(input)"] : []),
  ...over,
});

const byName = (n: string, c = caps()) => buildRepoAgentTools(c).find((t) => t.spec.name === n)!;

test("exposes the five repo tools", () => {
  const names = buildRepoAgentTools(caps()).map((t) => t.spec.name).sort();
  expect(names).toEqual(["grep", "list_files", "query_reachability", "query_sast", "read_file"]);
});

test("read_file returns contents", async () => {
  expect(await byName("read_file").run({ path: "src/a.ts" })).toContain("export const x");
});

test("read_file rejects path traversal", async () => {
  expect(await byName("read_file").run({ path: "../../etc/passwd" })).toMatch(/^ERROR:/);
});

test("read_file rejects query-injection chars", async () => {
  expect(await byName("read_file").run({ path: "a.ts?ref=evil" })).toMatch(/^ERROR:/);
});

test("read_file miss is not an error", async () => {
  expect(await byName("read_file").run({ path: "src/missing.ts" })).toContain("file not found");
});

test("grep returns bounded matches", async () => {
  expect(await byName("grep").run({ pattern: "eval" })).toContain("src/b.ts:4");
});

test("grep with no matches reports cleanly", async () => {
  expect(await byName("grep").run({ pattern: "nope" })).toContain("no matches");
});

test("query_reachability degrades gracefully when no client", async () => {
  expect(await byName("query_reachability").run({ file: "src/b.ts", line: 4 })).toContain("unknown");
});

test("query_sast degrades gracefully when no runner", async () => {
  expect(await byName("query_sast").run({})).toContain("no static-analysis");
});

test("createFsRepoCapabilities reads inside repo, blocks escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-repo-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "const secret = 1; eval(userInput);", "utf8");
  const c = createFsRepoCapabilities(dir);
  expect(await c.readFile("src/a.ts")).toContain("eval(userInput)");
  expect(await c.readFile("../../../../etc/passwd")).toBeNull(); // escape blocked
  const files = await c.listFiles("");
  expect(files).toContain("src/a.ts");
  const hits = await c.grep("eval");
  expect(hits.some((h) => h.includes("src/a.ts"))).toBe(true);
});

test("createFsRepoCapabilities blocks symlink escape (realpath confinement)", async () => {
  // A malicious repo can commit a tracked symlink whose lexical path is inside
  // the checkout but whose target escapes it. read_file must NOT follow it, and
  // grep/list_files must NOT slurp/list it.
  const outside = await mkdtemp(join(tmpdir(), "harness-outside-"));
  await writeFile(join(outside, "host-secret.txt"), "TOPSECRET host file", "utf8");
  const dir = await mkdtemp(join(tmpdir(), "harness-repo-"));
  await writeFile(join(dir, "real.ts"), "const ok = 1;", "utf8");
  await symlink(join(outside, "host-secret.txt"), join(dir, "secrets")); // secrets -> /…/host-secret.txt
  const c = createFsRepoCapabilities(dir);

  expect(await c.readFile("secrets")).toBeNull(); // symlink not followed out of sandbox
  expect(await c.readFile("real.ts")).toContain("const ok"); // real file still reads
  const files = await c.listFiles("");
  expect(files).toContain("real.ts");
  expect(files).not.toContain("secrets"); // symlink not listed
  const hits = await c.grep("TOPSECRET");
  expect(hits.length).toBe(0); // host-secret content not reachable via grep
});

test("query_reachability rejects non-positive / NaN line", async () => {
  const t = byName("query_reachability", caps({ reachability: { analyze: async () => ({}) } as never }));
  expect(await t.run({ file: "src/a.ts", line: -1 })).toMatch(/^ERROR: line/);
  expect(await t.run({ file: "src/a.ts", line: 0 })).toMatch(/^ERROR: line/);
  expect(await t.run({ file: "src/a.ts", line: "x" })).toMatch(/^ERROR: line/);
  expect(await t.run({ file: "src/a.ts", line: 1.5 })).toMatch(/^ERROR: line/);
});
