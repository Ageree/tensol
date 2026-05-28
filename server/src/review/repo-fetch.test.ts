/**
 * repo-fetch tests — synthesized full-add patch, git clone cleanup/walk via an
 * injected spawn, and the in-memory FakeRepoFetcher.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitRepoFetcher,
  fileToAddedDiff,
  FakeRepoFetcher,
} from "./repo-fetch.ts";

describe("fileToAddedDiff", () => {
  test("empty content -> empty patch", () => {
    expect(fileToAddedDiff("")).toBe("");
  });
  test("single line (with trailing newline)", () => {
    expect(fileToAddedDiff("a\n")).toBe("@@ -0,0 +1,1 @@\n+a");
  });
  test("two lines, no trailing newline", () => {
    expect(fileToAddedDiff("a\nb")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  });
});

describe("createGitRepoFetcher", () => {
  test("throws and cleans up the temp checkout when git clone fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "wb-test-root-"));
    try {
      const fetcher = createGitRepoFetcher({
        tmpRoot: root,
        spawn: async () => ({ exitCode: 128, stderr: "fatal: repo not found" }),
      });
      await expect(
        fetcher.fetch({ cloneUrl: "https://github.com/x/y.git" }),
      ).rejects.toThrow(/git clone failed/);
      // The mkdtemp'd checkout under root must have been removed.
      expect(readdirSync(root).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walks the checkout, skips vendored dirs + oversized files", async () => {
    const root = mkdtempSync(join(tmpdir(), "wb-test-root-"));
    try {
      // Injected spawn materializes a fixture tree into the clone target dir.
      const fetcher = createGitRepoFetcher({
        tmpRoot: root,
        spawn: async (cmd: string[]) => {
          const dir = cmd[cmd.length - 1] as string;
          mkdirSync(join(dir, "src"), { recursive: true });
          writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
          writeFileSync(join(dir, "README.md"), "# not source\n"); // ext filtered out
          mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
          writeFileSync(join(dir, "node_modules", "dep", "x.ts"), "vendored\n"); // skipped
          writeFileSync(join(dir, "big.ts"), "x".repeat(300 * 1024)); // > 256KiB skip
          return { exitCode: 0, stderr: "" };
        },
      });
      const checkout = await fetcher.fetch({ cloneUrl: "https://github.com/x/y.git" });
      const paths = checkout.files.map((f) => f.path).sort();
      expect(paths).toEqual(["src/a.ts"]); // README filtered, node_modules skipped, big.ts too large
      expect(checkout.files[0]!.status).toBe("added");
      expect(checkout.files[0]!.patch).toContain("+export const a = 1;");
      expect(checkout.repoDir).toBeDefined();
      // cleanup removes the checkout.
      await checkout.cleanup();
      expect(readdirSync(root).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("FakeRepoFetcher", () => {
  test("returns whole-file DiffFiles, no repoDir (SAST skipped), no-op cleanup", async () => {
    const fetcher = new FakeRepoFetcher({ "x.ts": "const x = 1\n" });
    const checkout = await fetcher.fetch({ cloneUrl: "u", ref: "main" });
    expect(fetcher.calls[0]!.ref).toBe("main");
    expect(checkout.files[0]!.path).toBe("x.ts");
    expect(checkout.files[0]!.status).toBe("added");
    expect(checkout.repoDir).toBeUndefined();
    await checkout.cleanup(); // must not throw
  });
});
