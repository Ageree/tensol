/**
 * T052 — PDF renderer.
 *
 * Turns an HTML string (produced by `template.html.ts`) into a PDF buffer
 * using `puppeteer-core` + `@sparticuz/chromium-min` per research §R7.
 * The chromium-min binary is the Lambda-style portable Chromium build —
 * it ships small (~50MB tarball) and is downloaded once on first launch,
 * which avoids bloating the production image.
 *
 * Design notes
 * ------------
 *   - The 60-second timeout matches research §R7. Both `page.setContent`
 *     and `page.pdf` carry the same budget; if either hangs, we abort
 *     and throw `PDFRenderError`.
 *   - `renderReport` accepts an HTML string (not a `scanId`) so the
 *     function is trivially unit-testable in isolation. The route layer
 *     and the `render-pdf` job handler are responsible for loading the
 *     scan / findings from the DB and calling `renderReportHtml`
 *     beforehand. This keeps `pdf.ts` a thin shell with no DB coupling.
 *   - Dependency injection via `RenderReportOpts`: the puppeteer
 *     launcher and the chromium executable-path resolver are both
 *     swappable. Tests inject a fake launcher; the production job
 *     handler injects nothing and gets the default behavior.
 *   - The `Buffer.from` at the end normalises the puppeteer return
 *     type — `page.pdf()` returns `Uint8Array | Buffer` depending on
 *     version, so we coerce to a node-style `Buffer` for our callers.
 *   - Any failure (launch crash, navigation timeout, PDF crash) is
 *     wrapped in `PDFRenderError` so the job handler can categorise
 *     and retry per research §R7 (3-retry policy with 30s gap).
 */

import puppeteer, { type Browser, type LaunchOptions } from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

/**
 * Error class for any PDF render failure.
 *
 * Distinct subclass so retry logic in `jobs/handlers/render-pdf.ts`
 * (future T0XX) can `instanceof PDFRenderError` rather than parsing
 * messages.
 */
export class PDFRenderError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PDFRenderError";
    this.cause = cause;
  }
}

/** Default render timeout per research §R7. */
export const RENDER_TIMEOUT_MS = 60_000;

/** Default A4 page margins, mirrors the @page rule in template CSS. */
const DEFAULT_MARGIN = {
  top: "24mm",
  bottom: "24mm",
  left: "18mm",
  right: "18mm",
} as const;

/**
 * Subset of the puppeteer launcher signature we depend on.
 *
 * Declared as a standalone alias so tests can implement a fake without
 * having to import the full Puppeteer types.
 */
export type PuppeteerLauncher = (options?: LaunchOptions) => Promise<Browser>;

export interface RenderReportOpts {
  /** Override the puppeteer launcher (tests inject a fake). */
  readonly puppeteerLauncher?: PuppeteerLauncher;
  /** Override how the chromium executable path is resolved (tests inject a stub). */
  readonly chromiumExecutablePath?: () => Promise<string>;
  /** Override the render timeout (ms). Defaults to RENDER_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * Render `html` into a PDF buffer. Throws `PDFRenderError` on any failure.
 *
 * Caller is responsible for producing the HTML (via `renderReportHtml`)
 * and for persisting the resulting buffer to Object Storage (`reports.key`
 * / `reports.bucket`).
 */
export async function renderReport(
  html: string,
  opts: RenderReportOpts = {},
): Promise<Buffer> {
  const launcher: PuppeteerLauncher = opts.puppeteerLauncher ?? puppeteer.launch;
  const execPathResolver =
    opts.chromiumExecutablePath ?? (() => chromium.executablePath());
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;

  let browser: Browser | undefined;
  try {
    const executablePath = await execPathResolver();
    browser = await launcher({
      args: chromium.args,
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();
    // Note: `setContent` excludes `networkidle0` / `networkidle2` from its
    // type definition (puppeteer-core v25). For an offline HTML payload
    // with no external assets, `domcontentloaded` is the correct wait
    // condition — once the DOM is parsed, our inline CSS+SVG is ready.
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      timeout: timeoutMs,
      margin: DEFAULT_MARGIN,
      preferCSSPageSize: true,
    });

    return Buffer.from(pdf);
  } catch (cause) {
    throw new PDFRenderError(
      cause instanceof Error
        ? `PDF render failed: ${cause.message}`
        : "PDF render failed",
      cause,
    );
  } finally {
    if (browser !== undefined) {
      // close() swallows its own errors per puppeteer semantics, but we
      // catch defensively so a teardown failure cannot mask the real cause.
      try {
        await browser.close();
      } catch {
        // intentional: teardown noise must not shadow the original error.
      }
    }
  }
}
