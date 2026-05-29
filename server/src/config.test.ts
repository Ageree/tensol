import { test, expect, describe } from "bun:test";
import { loadConfig } from "./config.ts";

const HEX64 = "a".repeat(64);
const HEX64_B = "b".repeat(64);

const validEnv = {
  TENSOL_AUDIT_SIGNING_KEY: HEX64,
  TENSOL_SESSION_COOKIE_SECRET: HEX64_B,
  EMAIL_PROVIDER: "stdout",
  HETZNER_API_TOKEN: "hzr-token-xyz",
  HETZNER_SSH_KEY_NAME: "tensol-ops",
  TENSOL_VPS_AGENT_IMAGE: "ghcr.io/ageree/tensol-vps-agent:latest",
  TENSOL_WEBHOOK_BASE_URL: "https://api.tensol.example.com",
};

describe("loadConfig", () => {
  test("throws when TENSOL_AUDIT_SIGNING_KEY missing", () => {
    const env = { ...validEnv };
    delete (env as Record<string, unknown>).TENSOL_AUDIT_SIGNING_KEY;
    expect(() => loadConfig(env)).toThrow(/TENSOL_AUDIT_SIGNING_KEY/);
  });

  test("throws when TENSOL_SESSION_COOKIE_SECRET missing", () => {
    const env = { ...validEnv };
    delete (env as Record<string, unknown>).TENSOL_SESSION_COOKIE_SECRET;
    expect(() => loadConfig(env)).toThrow(/TENSOL_SESSION_COOKIE_SECRET/);
  });

  test("throws when HETZNER_API_TOKEN missing", () => {
    const env = { ...validEnv };
    delete (env as Record<string, unknown>).HETZNER_API_TOKEN;
    expect(() => loadConfig(env)).toThrow(/HETZNER_API_TOKEN/);
  });

  test("throws when TENSOL_WEBHOOK_BASE_URL is not a URL", () => {
    expect(() =>
      loadConfig({ ...validEnv, TENSOL_WEBHOOK_BASE_URL: "not-a-url" }),
    ).toThrow(/TENSOL_WEBHOOK_BASE_URL/);
  });

  test("throws when TENSOL_AUDIT_SIGNING_KEY shorter than 64 chars", () => {
    expect(() =>
      loadConfig({ ...validEnv, TENSOL_AUDIT_SIGNING_KEY: "short" }),
    ).toThrow(/TENSOL_AUDIT_SIGNING_KEY/);
  });

  test("throws when EMAIL_PROVIDER=resend but RESEND_API_KEY missing", () => {
    expect(() =>
      loadConfig({ ...validEnv, EMAIL_PROVIDER: "resend" }),
    ).toThrow(/RESEND_API_KEY/);
  });

  test("succeeds when EMAIL_PROVIDER=resend with RESEND_API_KEY", () => {
    const cfg = loadConfig({
      ...validEnv,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_key_123",
    });
    expect(cfg.EMAIL_PROVIDER).toBe("resend");
    expect(cfg.RESEND_API_KEY).toBe("re_test_key_123");
  });

  test("succeeds in stdout mode without RESEND_API_KEY", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.EMAIL_PROVIDER).toBe("stdout");
    expect(cfg.RESEND_API_KEY).toBeUndefined();
  });

  test("valid env returns typed object with proper types", () => {
    const cfg = loadConfig({ ...validEnv, PORT: "8080", NODE_ENV: "production" });
    expect(cfg.TENSOL_AUDIT_SIGNING_KEY).toBe(HEX64);
    expect(cfg.TENSOL_SESSION_COOKIE_SECRET).toBe(HEX64_B);
    expect(cfg.PORT).toBe(8080);
    expect(typeof cfg.PORT).toBe("number");
    expect(cfg.NODE_ENV).toBe("production");
    expect(cfg.TENSOL_WEBHOOK_BASE_URL).toBe("https://api.tensol.example.com");
  });

  test("applies defaults when optional vars unset", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.HETZNER_LOCATION).toBe("fsn1");
    expect(cfg.HETZNER_SERVER_TYPE).toBe("cpx21");
    expect(cfg.HETZNER_IMAGE).toBe("ubuntu-24.04");
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.EMAIL_PROVIDER).toBe("stdout");
  });

  test("rejects invalid NODE_ENV value", () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: "staging" }),
    ).toThrow(/NODE_ENV/);
  });

  test("rejects invalid EMAIL_PROVIDER value", () => {
    expect(() =>
      loadConfig({ ...validEnv, EMAIL_PROVIDER: "sendgrid" }),
    ).toThrow(/EMAIL_PROVIDER/);
  });

  test("coerces PORT from string", () => {
    const cfg = loadConfig({ ...validEnv, PORT: "9090" });
    expect(cfg.PORT).toBe(9090);
  });

  test("rejects non-numeric PORT", () => {
    expect(() =>
      loadConfig({ ...validEnv, PORT: "not-a-number" }),
    ).toThrow(/PORT/);
  });

  test("review LLM API key falls back to the shared OpenRouter key when unset", () => {
    const cfg = loadConfig({
      ...validEnv,
      TENSOL_OPENROUTER_API_KEY: "sk-or-v1-shared",
    });
    expect(cfg.TENSOL_REVIEW_LLM_API_KEY).toBe("sk-or-v1-shared");
  });

  test("review-specific LLM API key takes precedence over the shared key", () => {
    const cfg = loadConfig({
      ...validEnv,
      TENSOL_OPENROUTER_API_KEY: "sk-or-v1-shared",
      TENSOL_REVIEW_LLM_API_KEY: "sk-or-v1-review",
    });
    expect(cfg.TENSOL_REVIEW_LLM_API_KEY).toBe("sk-or-v1-review");
  });

  test("review LLM API key stays empty when neither key is set", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.TENSOL_REVIEW_LLM_API_KEY).toBe("");
  });
});
