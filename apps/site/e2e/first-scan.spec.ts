/**
 * T090 — End-to-end "first scan" hybrid UI + API test.
 *
 * Lifecycle covered (per tasks.md line 164):
 *   1. Register via the magic-link UI (POST /api/auth/request-link →
 *      stdout-logged verify URL → browser hits GET /api/auth/verify).
 *   2. Create a project via the backend API.
 *   3. Add a target via the backend API.
 *   4. Fake the DNS challenge — `tensol-test-server.ts` wires a fake
 *      `verifyDeps.resolveTxt` that returns the live challenge token, so
 *      POST /api/targets/:id/auth-proof/verify succeeds without a real DNS
 *      record. This is exactly the "fake DNS challenge → verify" leg the
 *      task spec calls out.
 *   5. Start a scan (POST /api/scans).
 *   6. Wait for the scan to reach status='running' (spawn_vps + dispatch_scan
 *      job handlers complete against fakes, so this is deterministic).
 *   7. Simulate the VPS pushing a canned finding via the real
 *      /webhooks/scan-progress endpoint — body signed with the per-VPS
 *      sign_key minted by the spawn_vps handler. The webhook receiver
 *      validates the HMAC, stores the finding, and transitions the scan
 *      to status='completed'.
 *   8. Assert the finding is queryable through the backend (GET
 *      /api/scans/:id surface and audit timeline).
 *
 * Why hybrid and not pure UI:
 *   T081 only wired the Login.tsx page to the new v2 backend. Projects /
 *   Targets / Scans / Findings pages still consume mock data per T081's
 *   commit notes, so a full UI E2E is impossible without forward-coupling
 *   T090 to T082-T087 (deferred). The hybrid approach exercises the SAME
 *   backend code that a fully-wired UI would hit — only the keystrokes
 *   change. When T082+ lands, this spec stays valid and a sister spec can
 *   be added to drive the UI buttons.
 *
 * Mock surface:
 *   - Hetzner VPS provider is faked (`createFakeProvider` in
 *     `tensol-test-server.ts`) so spawn / status / destroy return canned
 *     values with no cloud calls.
 *   - The dispatch_scan handler's fetchImpl is faked to return 202 so the
 *     handler does not try to reach a non-existent VPS at 203.0.113.42.
 *   - Auth-proof verify's DNS resolver is faked to always return the
 *     pending challenge token.
 *   - The /webhooks/scan-progress endpoint is hit with REAL HMAC signing
 *     using the same per-VPS sign_key the spawn handler wrote into the
 *     DB. This proves the webhook contract end-to-end (signature → store
 *     finding → scan transition → audit emission).
 *
 * No Playwright route-mocks are necessary at this layer because every
 * external dependency is already swapped at the backend composition root.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { createHmac } from 'node:crypto';

const BACKEND_BASE_URL =
  process.env.TENSOL_E2E_BACKEND_BASE_URL ?? 'http://127.0.0.1:3001';

const TEST_EMAIL = `e2e+${Date.now()}@example.test`;

// HMAC key used by the test-server composition root (must match the
// SIGNING_KEY constant in helpers/tensol-test-server.ts — that key signs
// the audit chain, NOT the webhook HMAC; webhook uses the per-VPS sign_key
// stored in vps_instances which we read from the DB-derived audit chain
// metadata via the test-only email log endpoint... actually no, we read
// it via a dedicated peek endpoint added below).

// Wait helper: poll a predicate every `intervalMs` until it returns truthy
// or `timeoutMs` elapses.
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  opts: { intervalMs: number; timeoutMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== undefined && last !== null && last !== false) {
      return last;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(
    `pollUntil(${opts.label}) timed out after ${opts.timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

interface EmailLogResponse {
  lines: string[];
}

async function extractMagicLink(ctx: {
  request: typeof pwRequest;
  email: string;
}): Promise<string> {
  // The verify URL pattern emitted by `email/templates/magic-link.ts`:
  //   http://<host>:<port>/api/auth/verify?token=<urlsafe>
  const VERIFY_URL_RE = /(https?:\/\/[^\s"<>]+\/api\/auth\/verify\?token=[A-Za-z0-9._%~\-]+)/;
  const apiContext = await ctx.request.newContext({ baseURL: BACKEND_BASE_URL });
  try {
    const found = await pollUntil(
      async () => {
        const res = await apiContext.get('/__test/email-log');
        if (!res.ok()) return undefined;
        const body = (await res.json()) as EmailLogResponse;
        // Walk lines newest-last; find the most recent send that contains
        // `to: <email>` followed by a verify URL.
        for (const block of body.lines) {
          if (!block.includes(`to:      ${ctx.email}`)) continue;
          const match = block.match(VERIFY_URL_RE);
          if (match && match[1]) return match[1];
        }
        return undefined;
      },
      { intervalMs: 200, timeoutMs: 5_000, label: 'magic-link-email' },
    );
    return found;
  } finally {
    await apiContext.dispose();
  }
}

interface ApiContextLike {
  get: (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => Promise<{
    ok: () => boolean;
    status: () => number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    headers: () => Record<string, string>;
  }>;
  post: (
    url: string,
    opts?: { headers?: Record<string, string>; data?: unknown; body?: Buffer | string },
  ) => Promise<{
    ok: () => boolean;
    status: () => number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    headers: () => Record<string, string>;
  }>;
}

test.describe('T090 — first scan end-to-end', () => {
  test.setTimeout(60_000);

  test('register → project → target → verify → scan → webhook → finding', async ({
    page,
    request,
  }) => {
    // ─────────────────────────────────────────────────────────────────────
    // 1. Register via UI: open /login, submit email, observe "sent" state.
    // ─────────────────────────────────────────────────────────────────────
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.locator('input[type=text], input:not([type])').first();
    await emailInput.fill(TEST_EMAIL);
    await page.locator('form button').first().click();

    // Login.tsx renders STATUS: link_dispatched after a successful POST.
    await expect(page.locator('text=link_dispatched')).toBeVisible({
      timeout: 10_000,
    });

    // ─────────────────────────────────────────────────────────────────────
    // 2. Extract the magic-link URL from the captured email log.
    // ─────────────────────────────────────────────────────────────────────
    const verifyUrl = await extractMagicLink({
      request: pwRequest,
      email: TEST_EMAIL,
    });
    expect(verifyUrl).toMatch(/\/api\/auth\/verify\?token=/);

    // The verifyUrl points at the backend (port 3001), but our vite proxy
    // also accepts /api/* so we route the GET through the frontend so the
    // session cookie lands on the same origin Playwright drives. Rewrite
    // host to the dev origin.
    const verifyPath = new URL(verifyUrl).pathname + new URL(verifyUrl).search;

    // ─────────────────────────────────────────────────────────────────────
    // 3. Follow the magic link — browser-side so the session cookie is
    //    set on the Playwright page context.
    // ─────────────────────────────────────────────────────────────────────
    const verifyResp = await page.goto(verifyPath);
    // The backend 302-redirects to /dashboard. Our /dashboard route exists
    // (lazy-loaded shell) so the response is OK.
    expect(verifyResp?.status() ?? 0).toBeLessThan(400);

    // Confirm the session cookie was written.
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === 'tensol_session');
    expect(sessionCookie?.value).toBeTruthy();

    // ─────────────────────────────────────────────────────────────────────
    // 4. Build an APIRequestContext bound to the page origin with the
    //    session cookie copied in from the browser context. Playwright's
    //    built-in `request` fixture does NOT auto-share cookies with the
    //    browser context, so we construct a fresh one with explicit
    //    storageState (matches Playwright docs §"sharing storage state").
    // ─────────────────────────────────────────────────────────────────────
    void request;
    const storageState = await page.context().storageState();
    const apiCtx = await pwRequest.newContext({
      baseURL: 'http://127.0.0.1:5175',
      storageState,
    });
    const api = apiCtx as unknown as ApiContextLike;

    // 4a. POST /api/projects.
    const projRes = await api.post('/api/projects', {
      headers: { 'content-type': 'application/json' },
      data: { name: 'E2E project' },
    });
    expect(projRes.status()).toBe(201);
    const projBody = (await projRes.json()) as { project: { id: string; name: string } };
    expect(projBody.project.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const projectId = projBody.project.id;

    // 4b. POST /api/projects/:id/targets — add target.
    const tgtRes = await api.post(
      `/api/projects/${projectId}/targets`,
      {
        headers: { 'content-type': 'application/json' },
        data: { url: 'https://example.test' },
      },
    );
    expect(tgtRes.status()).toBe(201);
    const tgtBody = (await tgtRes.json()) as {
      target: { id: string; url: string; status: string };
    };
    expect(tgtBody.target.status).toBe('unverified');
    const targetId = tgtBody.target.id;

    // ─────────────────────────────────────────────────────────────────────
    // 5. Issue auth-proof challenge.
    // ─────────────────────────────────────────────────────────────────────
    const challengeRes = await api.post(
      `/api/targets/${targetId}/auth-proof/challenge`,
    );
    expect(challengeRes.status()).toBe(201);

    // ─────────────────────────────────────────────────────────────────────
    // 6. Verify — the test-server's fake `resolveTxt` returns the live
    //    challenge token, so dns_txt always succeeds here.
    // ─────────────────────────────────────────────────────────────────────
    const verifyApiRes = await api.post(
      `/api/targets/${targetId}/auth-proof/verify`,
      {
        headers: { 'content-type': 'application/json' },
        data: {},
      },
    );
    expect(verifyApiRes.status()).toBe(200);
    const verifyBody = (await verifyApiRes.json()) as {
      verified: boolean;
      method?: string;
    };
    expect(verifyBody.verified).toBe(true);
    expect(verifyBody.method).toBe('dns_txt');

    // ─────────────────────────────────────────────────────────────────────
    // 7. Start the scan.
    // ─────────────────────────────────────────────────────────────────────
    const scanRes = await api.post('/api/scans', {
      headers: { 'content-type': 'application/json' },
      data: { target_id: targetId, profile: 'recon' },
    });
    expect(scanRes.status()).toBe(201);
    const scanBody = (await scanRes.json()) as { scan: { id: string; status: string } };
    const scanId = scanBody.scan.id;
    expect(scanId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(['queued', 'running']).toContain(scanBody.scan.status);

    // ─────────────────────────────────────────────────────────────────────
    // 8. Wait for the job runner to transition the scan to 'running' —
    //    the spawn_vps handler INSERTs a vps_instances row whose sign_key
    //    we need to compute the webhook HMAC.
    //
    //    Poll GET /api/scans/:id until status='running', then read the
    //    sign_key out of the audit metadata. The spawn_vps handler emits
    //    a `vps_provisioned` audit row but does NOT include sign_key in
    //    metadata (intentional — sign_key is per-VPS shared secret). We
    //    therefore use a dedicated test-only peek endpoint added to the
    //    test server: /__test/vps-sign-key/:scanId.
    // ─────────────────────────────────────────────────────────────────────
    await pollUntil(
      async () => {
        const r = await api.get(`/api/scans/${scanId}`);
        if (!r.ok()) return undefined;
        const body = (await r.json()) as { scan: { status: string } };
        return body.scan.status === 'running' ? true : undefined;
      },
      { intervalMs: 200, timeoutMs: 20_000, label: 'scan→running' },
    );

    // Fetch the sign_key via the test-only endpoint (added in
    // helpers/tensol-test-server.ts).
    const backendCtx = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    let signKey: string;
    try {
      const skRes = await backendCtx.get(`/__test/vps-sign-key/${scanId}`);
      expect(skRes.ok()).toBe(true);
      const skBody = (await skRes.json()) as { sign_key: string };
      signKey = skBody.sign_key;
      expect(signKey).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await backendCtx.dispose();
    }

    // ─────────────────────────────────────────────────────────────────────
    // 9. Simulate the VPS pushing a canned finding via the real webhook.
    //    HMAC-SHA256 over the exact bytes the backend reads via c.req.text().
    // ─────────────────────────────────────────────────────────────────────
    const cannedPayload = {
      scan_id: scanId,
      status: 'done',
      failure_reason: null,
      usage: { tokens: 12_345, usd_cents: 42 },
      findings: [
        {
          severity: 'medium' as const,
          title: 'Example XSS reflected in search param',
          body_md: 'A reflected XSS was identified at `/search?q=<payload>`.',
          evidence: {
            request: 'GET /search?q=%3Cscript%3E HTTP/1.1',
            response: 'HTTP/1.1 200 OK\\n\\n<html>...<script>...</script></html>',
          },
        },
      ],
    };
    const rawBody = JSON.stringify(cannedPayload);
    const signature = createHmac('sha256', signKey).update(rawBody).digest('hex');

    const webhookCtx = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    try {
      const wRes = await webhookCtx.post('/webhooks/scan-progress', {
        headers: {
          'content-type': 'application/json',
          'x-tensol-scan-id': scanId,
          'x-tensol-signature': signature,
        },
        data: rawBody,
      });
      expect(wRes.status()).toBe(200);
      const wBody = (await wRes.json()) as {
        ok: boolean;
        inserted?: number;
        skipped?: number;
      };
      expect(wBody.ok).toBe(true);
      expect(wBody.inserted).toBe(1);
    } finally {
      await webhookCtx.dispose();
    }

    // ─────────────────────────────────────────────────────────────────────
    // 10. Assert the scan transitioned to 'completed' via GET /api/scans/:id.
    //    (GET /api/scans/:id does NOT yet return findings inline — the
    //    production findings endpoint is a deferred task. We assert the
    //    row exists via the test-only peek below.)
    // ─────────────────────────────────────────────────────────────────────
    await pollUntil(
      async () => {
        const r = await api.get(`/api/scans/${scanId}`);
        if (!r.ok()) return undefined;
        const body = (await r.json()) as { scan: { status: string } };
        return body.scan.status === 'completed' ? true : undefined;
      },
      { intervalMs: 100, timeoutMs: 5_000, label: 'scan→completed' },
    );

    // 10b. Confirm the finding row landed via the test-only peek.
    const findingsCtx = await pwRequest.newContext({ baseURL: BACKEND_BASE_URL });
    try {
      const fRes = await findingsCtx.get(`/__test/findings/${scanId}`);
      expect(fRes.ok()).toBe(true);
      const fBody = (await fRes.json()) as {
        findings: Array<{ title: string; severity: string }>;
      };
      expect(fBody.findings.length).toBe(1);
      expect(fBody.findings[0]?.title).toContain('XSS');
      expect(fBody.findings[0]?.severity).toBe('medium');
    } finally {
      await findingsCtx.dispose();
    }

    // ─────────────────────────────────────────────────────────────────────
    // 11. Audit timeline should include scan_started + scan_completed.
    //     Route returns `{events: [...]}`.
    // ─────────────────────────────────────────────────────────────────────
    const auditRes = await api.get(`/api/scans/${scanId}/audit`);
    expect(auditRes.status()).toBe(200);
    const auditBody = (await auditRes.json()) as {
      events: Array<{ event: string; outcome: string }>;
    };
    const events = auditBody.events.map((row) => row.event);
    expect(events).toContain('scan_started');
    expect(events).toContain('scan_completed');

    await apiCtx.dispose();
  });
});
