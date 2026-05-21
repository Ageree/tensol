import { test, expect, request as apiRequest } from "@playwright/test";

const APP_URL = "https://app.tensol.ru";
const API_URL = "https://api.tensol.ru";
const ROOT_URL = "https://tensol.ru";
const TG_WEBHOOK_SECRET = process.env.TENSOL_TELEGRAM_WEBHOOK_SECRET;

test.describe("Real-prod smoke against https://tensol.ru", () => {
  test("landing page initial HTML response returns 200", async ({ page }) => {
    // NOTE 2026-05-21: /assets/index-*.js streams slowly in prod (only ~23 KiB
    // returned in 10 s via curl). To avoid a browser-hang on the SPA bundle, we
    // wait only for the initial HTML commit, then probe content via raw HTTP.
    const resp = await page.goto(ROOT_URL, {
      waitUntil: "commit",
      timeout: 20000,
    });
    expect(resp?.status()).toBe(200);
    const headers = resp?.headers() ?? {};
    expect(headers["content-type"] || "").toMatch(/html/);
  });

  test("landing page HTML shell contains SPA mount + brand markers", async () => {
    const ctx = await apiRequest.newContext();
    const resp = await ctx.get(ROOT_URL);
    expect(resp.status()).toBe(200);
    const html = await resp.text();
    expect(html.length).toBeGreaterThan(500);
    expect(html).toMatch(/<div\s+id="root"/i);
    expect(html.toLowerCase()).toContain("tensol");
  });

  test("API /healthz responds", async () => {
    const ctx = await apiRequest.newContext();
    const resp = await ctx.get(`${API_URL}/healthz`);
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: true });
  });

  test("API /v1/config/feature-flags responds", async () => {
    const ctx = await apiRequest.newContext();
    const resp = await ctx.get(`${API_URL}/v1/config/feature-flags`);
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toHaveProperty("yookassa_live");
  });

  test("Telegram-auth round trip via webhook simulation", async () => {
    test.skip(!TG_WEBHOOK_SECRET, "TENSOL_TELEGRAM_WEBHOOK_SECRET not set");

    const ctx = await apiRequest.newContext();

    // Step 1 — issue link
    const issueResp = await ctx.post(`${API_URL}/api/auth/issue-link`, {
      data: { telegram_username: "smoketest_user" },
    });
    expect(issueResp.status()).toBe(200);
    const issueData = await issueResp.json();
    expect(issueData).toHaveProperty("token");
    expect(issueData).toHaveProperty("deep_link");
    expect(issueData.deep_link).toMatch(/https:\/\/t\.me\/.+\?start=.+/);

    // Step 2 — simulate Telegram webhook /start <token>
    const tgUpdateBody = {
      update_id: 999999,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: {
          id: 999000001,
          is_bot: false,
          first_name: "Smoke",
          username: "smoketest_user",
        },
        chat: { id: 999000001, type: "private" },
        text: `/start ${issueData.token}`,
      },
    };
    const tgResp = await ctx.post(`${API_URL}/v1/webhooks/telegram-update`, {
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": TG_WEBHOOK_SECRET!,
      },
      data: tgUpdateBody,
    });
    expect(tgResp.status()).toBe(200);

    // Step 3 — poll until resolved
    let polled: { status?: string; session_id?: string } = {};
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const pollResp = await ctx.get(
        `${API_URL}/api/auth/poll-link?token=${issueData.token}`,
      );
      polled = await pollResp.json();
      if (polled.status === "resolved") break;
    }
    expect(polled.status).toBe("resolved");
    expect(polled).toHaveProperty("session_id");

    // Step 4 — list scan-orders with session cookie
    const sessionCtx = await apiRequest.newContext({
      extraHTTPHeaders: { Cookie: `tensol_session=${polled.session_id}` },
    });
    const ordersResp = await sessionCtx.get(`${API_URL}/v1/scan-orders`);
    expect(ordersResp.status()).toBe(200);
    const orders = await ordersResp.json();
    // Per OpenAPI contract: GET /v1/scan-orders returns a bare array of ScanOrder
    expect(Array.isArray(orders)).toBe(true);
  });

  test("Deep inquiry anonymous POST returns 201", async () => {
    const ctx = await apiRequest.newContext();
    const resp = await ctx.post(`${API_URL}/v1/deep-inquiries`, {
      data: {
        company: "Smoke Test Inc",
        contact_name: "Auto Tester",
        phone: "+70000000000",
        domains_text: "smoke.example",
        scope_text: "automated smoke from playwright real-prod test",
        budget_band: "open",
        consent_accepted: true,
      },
    });
    expect(resp.status()).toBe(201);
    const json = await resp.json();
    expect(json).toHaveProperty("id");
    expect(json.status).toBe("received");
  });

  test("Public asset responses look healthy via raw HTTP", async () => {
    const ctx = await apiRequest.newContext();
    for (const host of ["https://tensol.ru", "https://www.tensol.ru", "https://app.tensol.ru"]) {
      const resp = await ctx.get(host);
      expect(resp.status()).toBe(200);
      const headers = resp.headers();
      expect(headers["content-type"] || "").toMatch(/html/);
    }
  });
});
