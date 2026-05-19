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
    // Make sure rejected has the expected files
    const rejectedFiles = rejected.map((r) => r.file).sort();
    expect(rejectedFiles).toEqual([
      "bad-severity.md",
      "invalid-yaml.md",
      "missing-title.md",
      "no-frontmatter.md",
    ]);
  });

  test("returns findings ordered alphabetically by filename", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const titles = findings.map((f) => f.title);
    // Sorted alphabetically by source filename:
    //   high-sqli-products.md → "SQL injection ..."
    //   info-banner.md        → "Server banner ..."
    //   medium-xss-search.md  → "Reflected XSS ..."
    expect(titles).toEqual([
      "SQL injection in /api/products?id=",
      "Server banner discloses nginx version",
      "Reflected XSS on /search?q=",
    ]);
  });

  test("coerces uppercase severity to lowercase", async () => {
    const { findings } = await collectFindings({ dir: FIXTURES });
    const banner = findings.find((f) => f.title.startsWith("Server banner"));
    expect(banner).toBeDefined();
    expect(banner!.severity).toBe("info");
  });

  test("rejects file missing frontmatter with reason='missing_frontmatter'", async () => {
    const { rejected } = await collectFindings({ dir: FIXTURES });
    const entry = rejected.find((r) => r.file === "no-frontmatter.md");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("missing_frontmatter");
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
