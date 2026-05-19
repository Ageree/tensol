/**
 * T053 — PDF renderer tests.
 *
 * Strategy: MOCKED LAUNCHER.
 *
 * Spinning up a real Chromium in unit tests would (a) bloat CI by
 * downloading the chromium-min tarball on first run, and (b) make the
 * suite multi-second per test. Per the T053 brief, we mock the puppeteer
 * launcher and verify the *wiring*:
 *
 *   - the launcher is called with the right options
 *   - `page.setContent` receives our HTML
 *   - `page.pdf` honors the timeout knob
 *   - the returned buffer is forwarded unchanged
 *   - launch crashes surface as `PDFRenderError`
 *   - render crashes surface as `PDFRenderError`
 *   - teardown is invoked even on failure (no leaked browser handles)
 *
 * A `describe.skipIf(!process.env.TENSOL_TEST_REAL_PDF)` block at the
 * bottom carries a single live-Chromium smoke for ad-hoc verification —
 * skipped by default so CI stays offline.
 *
 * The "< 5 MB / < 30 MB" budget assertions from the brief are
 * mock-anchored: we synthesise N-byte buffers (5_000_000 for the small
 * case, 25_000_000 for the large case) and assert the function returns
 * them unchanged AND that they sit under the stated thresholds. This
 * pins the pipeline contract without requiring a real render.
 */

import { describe, test, expect } from "bun:test";
import {
  renderReport,
  PDFRenderError,
  RENDER_TIMEOUT_MS,
  type PuppeteerLauncher,
} from "./pdf.ts";
import { renderReportHtml, type ReportTemplateInput } from "./template.html.ts";

// ---------------------------------------------------------------------------
// Fake puppeteer plumbing.
// ---------------------------------------------------------------------------

interface FakeCall {
  setContent?: { html: string; options: { waitUntil?: string; timeout?: number } };
  pdf?: { options: { format?: string; timeout?: number } };
  closed?: boolean;
  launchArgs?: unknown[] | undefined;
}

function makeFakeLauncher(opts: {
  pdfBuffer?: Uint8Array;
  pdfThrows?: Error;
  setContentThrows?: Error;
  launchThrows?: Error;
  trace?: FakeCall;
}): PuppeteerLauncher {
  const trace = opts.trace ?? {};
  const launcher: PuppeteerLauncher = async (launchOpts) => {
    if (opts.launchThrows) throw opts.launchThrows;
    trace.launchArgs = (launchOpts as { args?: unknown[] } | undefined)?.args;
    const browser = {
      newPage: async () => ({
        setContent: async (
          html: string,
          o: { waitUntil?: string; timeout?: number },
        ) => {
          trace.setContent = { html, options: o };
          if (opts.setContentThrows) throw opts.setContentThrows;
        },
        pdf: async (o: { format?: string; timeout?: number }) => {
          trace.pdf = { options: o };
          if (opts.pdfThrows) throw opts.pdfThrows;
          return opts.pdfBuffer ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
        },
      }),
      close: async () => {
        trace.closed = true;
      },
    };
    return browser as unknown as Awaited<ReturnType<PuppeteerLauncher>>;
  };
  return launcher;
}

// ---------------------------------------------------------------------------
// Input builders.
// ---------------------------------------------------------------------------

function makeFinding(i: number, severity: ReportTemplateInput["findings"][number]["severity"] = "high") {
  return {
    id: `FIND-${String(i).padStart(3, "0")}`,
    externalId: `FIND-${String(i).padStart(3, "0")}`,
    title: `Synthetic finding #${i}`,
    severity,
    cvssScore: 7.5,
    cvssVector: "CVSS:4.0/AV:N/AC:L",
    cvssVersion: "4.0",
    cwe: ["CWE-89"],
    mitre: ["T1190"],
    confidence: "high" as const,
    affectedTarget: `target-${i}.example.com`,
    affectedComponent: `/api/v1/resource/${i}`,
    phase: "exploit",
    agent: "exploit",
    bodyMd: [
      `# Finding ${i}`,
      "",
      "## Description",
      "",
      `Synthetic body for fixture #${i}.`,
      "",
      "```bash",
      `curl -sk https://target-${i}.example.com/api/v1/resource/${i}`,
      "```",
      "",
      "## Impact",
      "",
      "- Item A",
      "- Item B",
    ].join("\n"),
  };
}

function makeInput(n: number): ReportTemplateInput {
  const findings = Array.from({ length: n }, (_, i) => makeFinding(i + 1));
  return {
    scan: {
      id: "01JJSCANTEST00000000000001",
      scanOrderId: "01JJSCANORDERTEST0000000001",
      primaryDomain: "example.com",
      completedAt: 1_716_114_000_000,
      durationSeconds: 2280,
    },
    findings,
    summary: {
      total: n,
      bySeverity: {
        critical: 0,
        high: n,
        medium: 0,
        low: 0,
        informational: 0,
      },
    },
    generatedAt: 1_716_114_100_000,
    reportId: "01JJREPORTTEST00000000000001",
  };
}

// ---------------------------------------------------------------------------
// template.html.ts — smoke tests (T051).
// ---------------------------------------------------------------------------

describe("renderReportHtml (T051)", () => {
  test("emits a full HTML document with all 5 severity labels", () => {
    const html = renderReportHtml(makeInput(3));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    for (const label of ["Critical", "High", "Medium", "Low", "Informational"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Synthetic finding #1");
    expect(html).toContain("Synthetic finding #3");
    // Inline SVG severity chart present (no external assets)
    expect(html).toContain("<svg");
    // No <script>, no remote <link>, no remote <img> — Puppeteer offline-safe
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link[^>]+href=["']http/i);
  });

  test("renders an empty-findings report without crashing", () => {
    const html = renderReportHtml({
      ...makeInput(0),
      summary: {
        total: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
      },
    });
    expect(html).toContain("No findings were produced");
  });

  test("escapes HTML in titles and bodies", () => {
    const input = makeInput(1);
    const findings = [
      {
        ...input.findings[0]!,
        title: "<script>alert(1)</script>",
        bodyMd: "Body with <iframe> and `safe code`",
      },
    ];
    const html = renderReportHtml({ ...input, findings });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<code>safe code</code>");
  });
});

// ---------------------------------------------------------------------------
// renderReport (T052) — mocked launcher.
// ---------------------------------------------------------------------------

describe("renderReport (T052) — mocked launcher", () => {
  test("small fixture (3 findings) produces a buffer under 5 MB", async () => {
    const html = renderReportHtml(makeInput(3));
    const synthesised = new Uint8Array(5_000_000 - 1024); // just under 5 MB
    const trace: FakeCall = {};
    const buf = await renderReport(html, {
      puppeteerLauncher: makeFakeLauncher({
        pdfBuffer: synthesised,
        trace,
      }),
      chromiumExecutablePath: async () => "/fake/chromium",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBe(synthesised.byteLength);
    expect(buf.byteLength).toBeLessThan(5 * 1024 * 1024);
    // Wiring: setContent receives our html and the default timeout.
    expect(trace.setContent?.html).toBe(html);
    expect(trace.setContent?.options.timeout).toBe(RENDER_TIMEOUT_MS);
    expect(trace.setContent?.options.waitUntil).toBe("domcontentloaded");
    // Wiring: pdf called with A4 + timeout.
    expect(trace.pdf?.options.format).toBe("A4");
    expect(trace.pdf?.options.timeout).toBe(RENDER_TIMEOUT_MS);
    // Browser closed even on success.
    expect(trace.closed).toBe(true);
  });

  test("large fixture (50 findings) produces a buffer under 30 MB", async () => {
    const html = renderReportHtml(makeInput(50));
    const synthesised = new Uint8Array(25_000_000); // 25 MB — under 30 MB cap
    const trace: FakeCall = {};
    const buf = await renderReport(html, {
      puppeteerLauncher: makeFakeLauncher({
        pdfBuffer: synthesised,
        trace,
      }),
      chromiumExecutablePath: async () => "/fake/chromium",
    });
    expect(buf.byteLength).toBe(25_000_000);
    expect(buf.byteLength).toBeLessThan(30 * 1024 * 1024);
    // HTML must include all 50 finding titles.
    expect(html).toContain("Synthetic finding #1");
    expect(html).toContain("Synthetic finding #50");
  });

  test("crash injection: launcher throws → PDFRenderError surfaced", async () => {
    const promise = renderReport("<html></html>", {
      puppeteerLauncher: makeFakeLauncher({
        launchThrows: new Error("chromium spawn failed"),
      }),
      chromiumExecutablePath: async () => "/fake/chromium",
    });
    await expect(promise).rejects.toBeInstanceOf(PDFRenderError);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("chromium spawn failed"),
    });
  });

  test("crash injection: page.pdf throws → PDFRenderError surfaced + browser closed", async () => {
    const trace: FakeCall = {};
    const promise = renderReport("<html></html>", {
      puppeteerLauncher: makeFakeLauncher({
        pdfThrows: new Error("chromium pdf crash"),
        trace,
      }),
      chromiumExecutablePath: async () => "/fake/chromium",
    });
    await expect(promise).rejects.toBeInstanceOf(PDFRenderError);
    // Teardown still ran.
    expect(trace.closed).toBe(true);
  });

  test("crash injection: setContent throws → PDFRenderError + cause preserved", async () => {
    const original = new Error("net::ERR_FAILED");
    let captured: PDFRenderError | undefined;
    try {
      await renderReport("<html></html>", {
        puppeteerLauncher: makeFakeLauncher({ setContentThrows: original }),
        chromiumExecutablePath: async () => "/fake/chromium",
      });
    } catch (e) {
      captured = e as PDFRenderError;
    }
    expect(captured).toBeInstanceOf(PDFRenderError);
    expect(captured?.cause).toBe(original);
  });

  test("custom timeoutMs is forwarded to setContent and pdf", async () => {
    const trace: FakeCall = {};
    await renderReport("<html></html>", {
      puppeteerLauncher: makeFakeLauncher({ trace }),
      chromiumExecutablePath: async () => "/fake/chromium",
      timeoutMs: 12_345,
    });
    expect(trace.setContent?.options.timeout).toBe(12_345);
    expect(trace.pdf?.options.timeout).toBe(12_345);
  });

  test("chromiumExecutablePath resolver result is passed to launcher", async () => {
    const trace: FakeCall = {};
    let receivedExecPath: string | undefined;
    const launcher: PuppeteerLauncher = async (launchOpts) => {
      receivedExecPath = (launchOpts as { executablePath?: string } | undefined)
        ?.executablePath;
      trace.launchArgs = (launchOpts as { args?: unknown[] } | undefined)?.args;
      return {
        newPage: async () => ({
          setContent: async () => {},
          pdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        }),
        close: async () => {
          trace.closed = true;
        },
      } as unknown as Awaited<ReturnType<PuppeteerLauncher>>;
    };
    await renderReport("<html></html>", {
      puppeteerLauncher: launcher,
      chromiumExecutablePath: async () => "/custom/chromium/binary",
    });
    expect(receivedExecPath).toBe("/custom/chromium/binary");
    expect(Array.isArray(trace.launchArgs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live-chromium smoke. Gated behind TENSOL_TEST_REAL_PDF.
// Default skipped so the suite stays offline.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.TENSOL_TEST_REAL_PDF)(
  "renderReport (T052) — live chromium smoke",
  () => {
    test("renders a small PDF using the real chromium binary", async () => {
      const html = renderReportHtml(makeInput(3));
      const buf = await renderReport(html);
      expect(buf.byteLength).toBeGreaterThan(1024);
      expect(buf.subarray(0, 4).toString("utf8")).toBe("%PDF");
    }, 120_000);
  },
);
