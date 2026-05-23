import { describe, expect, test } from "bun:test";
import { collectFindings } from "../src/findings-collector.ts";

/**
 * Helper: build an in-memory file system for tests that need to inject
 * specific contents without touching disk. The real fixture directory
 * (`tests/fixtures/findings`) is used for the happy-path tests so that
 * we exercise the actual Bun file I/O path as well.
 */
function inMemoryFs(files: Record<string, string>) {
  const readDir = async (p: string): Promise<string[]> => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names: string[] = [];
    for (const key of Object.keys(files)) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) names.push(rest);
      }
    }
    return names;
  };
  const readFile = async (p: string): Promise<string> => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };
  return { readDir, readFile };
}

const FIXTURES = `${import.meta.dir}/fixtures/findings`;

describe("collectFindings (real fixture files)", () => {
  test("parses a complete fixture with frontmatter + evidence + body", async () => {
    const { findings, rejected } = await collectFindings({ dir: FIXTURES });
    const sqli = findings.find((f) =>
      f.title.startsWith("SQL injection")
    );
    expect(sqli).toBeDefined();
    expect(sqli!.severity).toBe("high");
    expect(sqli!.evidence?.request).toContain("GET /api/products?id=");
    expect(sqli!.evidence?.response).toContain("500 Internal Server Error");
    expect(sqli!.body_md).toContain("## Description");
    expect(sqli!.body_md).toContain("## Impact");
    // Frontmatter must NOT bleed into body
    expect(sqli!.body_md).not.toContain("severity: high");
    // Make sure rejected has the expected files. NOTE: `no-frontmatter.md`
    // is NO LONGER rejected — Bug #1 fix: frontmatter-less narrative files
    // (Decepticon recon SUMMARY/report) are now synthesized as info findings
    // so the operator gets the pentest narrative in the audit/UI.
    const rejectedFiles = rejected.map((r) => r.file).sort();
    expect(rejectedFiles).toEqual([
      "bad-severity.md",
      "invalid-yaml.md",
      "missing-title.md",
    ]);
  });

  test("returns findings ordered alphabetically by filename", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const titles = findings.map((f) => f.title);
    // Sorted alphabetically by absolute path:
    //   high-sqli-products.md → "SQL injection ..."
    //   info-banner.md        → "Server banner ..."
    //   medium-xss-search.md  → "Reflected XSS ..."
    //   no-frontmatter.md     → "Some random markdown" (first H1, synthetic)
    expect(titles).toEqual([
      "SQL injection in /api/products?id=",
      "Server banner discloses nginx version",
      "Reflected XSS on /search?q=",
      "Some random markdown",
    ]);
  });

  test("coerces uppercase severity to lowercase", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const banner = findings.find((f) => f.title.startsWith("Server banner"));
    expect(banner).toBeDefined();
    expect(banner!.severity).toBe("info");
  });

  test("synthesizes info finding from frontmatter-less narrative (Bug #1)", async () => {
    // Decepticon recon writes plain markdown to SUMMARY.md / report_*.md;
    // these now ride the webhook as severity:info findings instead of
    // being dropped on the floor.
    const { findings, rejected } = await collectFindings({ dir: FIXTURES });
    const synthetic = findings.find((f) => f.title === "Some random markdown");
    expect(synthetic).toBeDefined();
    expect(synthetic!.severity).toBe("info");
    expect(synthetic!.body_md).toContain("This file has no YAML frontmatter");
    expect(rejected.find((r) => r.file === "no-frontmatter.md")).toBeUndefined();
  });

  test("rejects file with invalid YAML with reason='invalid_yaml'", async () => {
    const { rejected } = await collectFindings({ dir: FIXTURES });
    const entry = rejected.find((r) => r.file === "invalid-yaml.md");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("invalid_yaml");
  });

  test("rejects file with out-of-enum severity", async () => {
    const { rejected } = await collectFindings({ dir: FIXTURES });
    const entry = rejected.find((r) => r.file === "bad-severity.md");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("invalid_severity");
  });

  test("rejects file missing title with reason='missing_title'", async () => {
    const { rejected } = await collectFindings({ dir: FIXTURES });
    const entry = rejected.find((r) => r.file === "missing-title.md");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("missing_title");
  });

  test("evidence is optional — finding without evidence parses cleanly", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const xss = findings.find((f) => f.title.startsWith("Reflected XSS"));
    expect(xss).toBeDefined();
    expect(xss!.evidence).toBeUndefined();
  });

  test("body preserved untouched (tabs, special chars, multi-line)", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const xss = findings.find((f) => f.title.startsWith("Reflected XSS"));
    expect(xss).toBeDefined();
    // Tab character is preserved
    expect(xss!.body_md).toContain("\tCode sample with tab:");
    expect(xss!.body_md).toContain("`<script>alert(1)</script>`");
    expect(xss!.body_md).toContain("Multi-line body\nwith several paragraphs.");
  });
});

describe("collectFindings (in-memory injection)", () => {
  test("ignores non-.md files in the directory", async () => {
    const files: Record<string, string> = {
      "/work/findings/finding-a.md":
        "---\nseverity: low\ntitle: A\n---\n\nbody",
      "/work/findings/notes.txt": "not a markdown file",
      "/work/findings/README": "no extension",
    };
    const { readDir, readFile } = inMemoryFs(files);
    const { findings, rejected } = await collectFindings({
      dir: "/work/findings",
      readDir,
      readFile,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.title).toBe("A");
    expect(rejected).toEqual([]);
  });

  test("severity 'CRITICAL' coerced to 'critical'", async () => {
    const { readDir, readFile } = inMemoryFs({
      "/f/x.md": "---\nseverity: CRITICAL\ntitle: rce\n---\n\nbody",
    });
    const { findings } = await collectFindings({
      dir: "/f",
      readDir,
      readFile,
    });
    expect(findings[0]!.severity).toBe("critical");
  });

  test("title must be a non-empty string", async () => {
    const { readDir, readFile } = inMemoryFs({
      "/f/x.md": "---\nseverity: low\ntitle: ''\n---\n\nbody",
    });
    const { rejected } = await collectFindings({
      dir: "/f",
      readDir,
      readFile,
    });
    expect(rejected[0]!.reason).toBe("missing_title");
  });

  test("empty body is allowed (body_md='')", async () => {
    const { readDir, readFile } = inMemoryFs({
      "/f/x.md": "---\nseverity: low\ntitle: t\n---\n",
    });
    const { findings, rejected } = await collectFindings({
      dir: "/f",
      readDir,
      readFile,
    });
    expect(rejected).toEqual([]);
    expect(findings[0]!.body_md).toBe("");
  });

  test("evidence with only request (no response) is preserved", async () => {
    const { readDir, readFile } = inMemoryFs({
      "/f/x.md":
        "---\nseverity: low\ntitle: t\nevidence:\n  request: 'GET /'\n---\n\nbody",
    });
    const { findings } = await collectFindings({
      dir: "/f",
      readDir,
      readFile,
    });
    expect(findings[0]!.evidence?.request).toBe("GET /");
    expect(findings[0]!.evidence?.response).toBeUndefined();
  });

  test("evidence not an object → rejected", async () => {
    const { readDir, readFile } = inMemoryFs({
      "/f/x.md":
        "---\nseverity: low\ntitle: t\nevidence: 'not an object'\n---\n\nbody",
    });
    const { rejected } = await collectFindings({
      dir: "/f",
      readDir,
      readFile,
    });
    expect(rejected[0]!.reason).toBe("invalid_evidence");
  });
});

// ---------------------------------------------------------------------------
// Bug #1 fix: recursive walk + multi-dir + narrative synthesis
// ---------------------------------------------------------------------------

/**
 * Rich-walker in-memory FS that returns DirEntry rows so the recursive
 * walker can descend without a stat call.
 */
function inMemoryRichFs(files: Record<string, string>) {
  const readDirRich = async (
    p: string,
  ): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const direct = new Map<string, "file" | "dir">();
    for (const key of Object.keys(files)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        direct.set(rest, "file");
      } else {
        const dirName = rest.slice(0, slash);
        if (!direct.has(dirName)) direct.set(dirName, "dir");
      }
    }
    if (direct.size === 0) {
      // Mimic ENOENT for nonexistent directories so the walker exercises
      // the silent-skip path.
      const anyChild = Object.keys(files).some((k) => k.startsWith(prefix));
      if (!anyChild && !files[p]) throw new Error(`ENOENT: ${p}`);
    }
    return Array.from(direct.entries()).map(([name, kind]) => ({
      name,
      isDirectory: kind === "dir",
      isFile: kind === "file",
    }));
  };
  const readFile = async (p: string): Promise<string> => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };
  return { readDirRich, readFile };
}

describe("collectFindings — recursive walk + narrative synthesis (Bug #1)", () => {
  test("walks subdirectories recursively (e.g. tensol-<scanId>/recon/)", async () => {
    const { readDirRich, readFile } = inMemoryRichFs({
      "/ws/tensol-X/recon/SUMMARY.md": "# Recon Summary\n\nFound 6 endpoints.",
      "/ws/tensol-X/recon/report_juiceshop.md":
        "# Juice Shop\n\nPlatform: Heroku.",
      "/ws/tensol-X/findings/high-xss.md":
        "---\nseverity: high\ntitle: XSS\n---\n\nbody",
    });
    const { findings, rejected } = await collectFindings({
      dirs: ["/ws/tensol-X"],
      readDirRich,
      readFile,
    });
    expect(rejected).toEqual([]);
    expect(findings.length).toBe(3);
    const titles = findings.map((f) => f.title).sort();
    expect(titles).toEqual(["Juice Shop", "Recon Summary", "XSS"]);
    const summary = findings.find((f) => f.title === "Recon Summary")!;
    expect(summary.severity).toBe("info");
    expect(summary.body_md).toContain("Found 6 endpoints.");
  });

  test("merges multiple root dirs without double-counting overlaps", async () => {
    const { readDirRich, readFile } = inMemoryRichFs({
      "/decepticon/tensol-X/recon/SUMMARY.md": "# A\n\nbody",
      "/tensol/findings/diag-litellm.md":
        "---\nseverity: info\ntitle: Container log\n---\n\nlogs",
    });
    const { findings } = await collectFindings({
      dirs: ["/decepticon/tensol-X", "/tensol/findings"],
      readDirRich,
      readFile,
    });
    expect(findings.length).toBe(2);
    expect(findings.map((f) => f.title).sort()).toEqual([
      "A",
      "Container log",
    ]);
  });

  test("missing directories are silently skipped (no recon dir for profile)", async () => {
    const { readDirRich, readFile } = inMemoryRichFs({
      "/tensol/findings/diag.md":
        "---\nseverity: info\ntitle: D\n---\n\nbody",
    });
    const { findings, rejected } = await collectFindings({
      dirs: ["/does/not/exist", "/tensol/findings"],
      readDirRich,
      readFile,
    });
    expect(rejected).toEqual([]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.title).toBe("D");
  });

  test("narrative without H1 falls back to filename stem as title", async () => {
    const { readDirRich, readFile } = inMemoryRichFs({
      "/ws/recon/notes.md": "Some narrative without any heading at all.",
    });
    const { findings } = await collectFindings({
      dirs: ["/ws"],
      readDirRich,
      readFile,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.title).toBe("notes");
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.body_md).toBe("Some narrative without any heading at all.");
  });

  test("body truncated to bodyCharCap when oversized", async () => {
    const huge = "x".repeat(60_000);
    const { readDirRich, readFile } = inMemoryRichFs({
      "/ws/big.md": `# Big\n\n${huge}`,
    });
    const { findings } = await collectFindings({
      dirs: ["/ws"],
      readDirRich,
      readFile,
    });
    expect(findings.length).toBe(1);
    // Default cap is 49_000 chars — must be <= server's 50_000 limit.
    expect(findings[0]!.body_md.length).toBe(49_000);
  });

  test("custom bodyCharCap is honored", async () => {
    const huge = "y".repeat(5_000);
    const { readDirRich, readFile } = inMemoryRichFs({
      "/ws/m.md": huge,
    });
    const { findings } = await collectFindings({
      dirs: ["/ws"],
      readDirRich,
      readFile,
      bodyCharCap: 1_000,
    });
    expect(findings[0]!.body_md.length).toBe(1_000);
  });

  test("no roots provided → empty result, no throw", async () => {
    const { findings, rejected } = await collectFindings({ dirs: [] });
    expect(findings).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
