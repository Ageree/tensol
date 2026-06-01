import { z } from "zod";

/**
 * Tensol backend v2 runtime configuration.
 *
 * All env vars are validated at module load via Zod. Missing or malformed
 * required vars fail fast on process startup (constitution VII: deterministic
 * boot, no silent fallbacks).
 *
 * For tests, call `loadConfig(env)` directly with an injected env record
 * instead of mutating `process.env`.
 */

const HEX_KEY_MIN_LEN = 64;

const ConfigSchema = z
  .object({
    // Audit chain HMAC key (T013/T014). Hex-encoded, ≥64 chars.
    TENSOL_AUDIT_SIGNING_KEY: z
      .string({ required_error: "TENSOL_AUDIT_SIGNING_KEY is required" })
      .min(HEX_KEY_MIN_LEN, {
        message: `TENSOL_AUDIT_SIGNING_KEY must be at least ${HEX_KEY_MIN_LEN} chars`,
      }),

    // Session cookie HMAC secret. Hex-encoded, ≥64 chars.
    TENSOL_SESSION_COOKIE_SECRET: z
      .string({ required_error: "TENSOL_SESSION_COOKIE_SECRET is required" })
      .min(HEX_KEY_MIN_LEN, {
        message: `TENSOL_SESSION_COOKIE_SECRET must be at least ${HEX_KEY_MIN_LEN} chars`,
      }),

    // Email delivery provider. `stdout` prints magic links to stdout (dev).
    EMAIL_PROVIDER: z.enum(["stdout", "resend"]).default("stdout"),

    // Required only when EMAIL_PROVIDER=resend (enforced in superRefine).
    RESEND_API_KEY: z.string().min(1).optional(),

    // Hetzner Cloud API token (server provisioning).
    HETZNER_API_TOKEN: z
      .string({ required_error: "HETZNER_API_TOKEN is required" })
      .min(1, { message: "HETZNER_API_TOKEN must not be empty" }),

    HETZNER_LOCATION: z.string().min(1).default("fsn1"),
    HETZNER_SERVER_TYPE: z.string().min(1).default("cpx21"),
    HETZNER_IMAGE: z.string().min(1).default("ubuntu-24.04"),

    HETZNER_SSH_KEY_NAME: z
      .string({ required_error: "HETZNER_SSH_KEY_NAME is required" })
      .min(1, { message: "HETZNER_SSH_KEY_NAME must not be empty" }),

    // Docker image tag for the vps-agent container.
    TENSOL_VPS_AGENT_IMAGE: z
      .string({ required_error: "TENSOL_VPS_AGENT_IMAGE is required" })
      .min(1, { message: "TENSOL_VPS_AGENT_IMAGE must not be empty" }),

    // T128 Bug #7 — OpenRouter API key for the Decepticon LiteLLM proxy
    // routing all model calls to `openrouter/qwen/qwen3.7-max`. Optional
    // with empty default so dev boot doesn't halt when the key is absent;
    // production deployments MUST set it or the spawned VM's LiteLLM
    // returns 401 on the first agent call and the scan hangs at recon.
    TENSOL_OPENROUTER_API_KEY: z.string().default(""),

    // LiteLLM master key (proxy-side auth between langgraph and litellm
    // containers inside the per-scan VM). The two values must match;
    // since both containers come from the same /opt/decepticon/.env,
    // they always do. Default is a safe synthetic constant — not a
    // secret, just a service-internal token.
    TENSOL_LITELLM_MASTER_KEY: z.string().default("sk-tensol-litellm-internal"),

    // Postgres password for the per-VM litellm-backing DB.
    TENSOL_POSTGRES_PASSWORD: z
      .string()
      .default("tensol-postgres-internal"),

    // Neo4j auth password for the per-VM KG (verifier reads it; recon
    // writes vulnerability nodes via Rule 4b KG_PERSISTENCE).
    TENSOL_NEO4J_PASSWORD: z.string().default("tensol-neo4j-internal"),

    // Public base URL where the server receives webhooks from VPS agents.
    TENSOL_WEBHOOK_BASE_URL: z
      .string({ required_error: "TENSOL_WEBHOOK_BASE_URL is required" })
      .url({ message: "TENSOL_WEBHOOK_BASE_URL must be a valid URL" }),

    // T074 — shared HMAC-SHA256 secret for the V2 `/v1/webhooks/scan-complete`
    // endpoint (T069). vps-agent signs with this same secret. Optional with
    // an empty default so dev boot doesn't halt when the env var is absent;
    // production deployments populate it. When unset, signature verification
    // simply fails for any inbound webhook (HMAC over an empty key produces
    // no match against a real signed payload).
    TENSOL_WEBHOOK_SECRET: z.string().default(""),

    // Pivot 2026-05-19 — Telegram bot webhook secret. Telegram attaches this
    // string in the `X-Telegram-Bot-Api-Secret-Token` header when delivering
    // bot updates; we verify it before parsing the body. Optional with empty
    // default so dev boot doesn't halt; when unset the `/v1/webhooks/telegram-
    // update` handler refuses every inbound (Telegram retries, but the
    // operator notices via the warn-log).
    TENSOL_TELEGRAM_WEBHOOK_SECRET: z.string().default(""),

    // T121 — comma-separated list of operator emails authorised to use the
    // `/v1/admin/*` surface (Deep-inquiry triage, etc.). Optional with empty
    // default so dev boot doesn't halt; the safe default is "no operators
    // configured, admin routes deny every authenticated user with 403". The
    // string is parsed into a normalized list at startup via
    // `parseOperatorEmails` (see `routes/admin/deep-inquiries.ts`).
    TENSOL_OPERATOR_EMAILS: z.string().default(""),

    // 003-whitebox — GitHub App (PR Review). All optional with empty defaults
    // so dev boot doesn't halt; the review domain degrades gracefully and the
    // webhook route 503s when unconfigured (no signature can verify against an
    // empty secret). Production deployments populate these from the GitHub App
    // settings page.
    GITHUB_APP_ID: z.string().default(""),
    // PEM private key (may contain literal `\n` — normalized at read time).
    GITHUB_APP_PRIVATE_KEY: z.string().default(""),
    GITHUB_APP_WEBHOOK_SECRET: z.string().default(""),
    GITHUB_APP_CLIENT_ID: z.string().default(""),

    // 003-whitebox — Review LLM (OpenRouter/LiteLLM-compatible). When the
    // review-specific key is unset it falls back to the shared OpenRouter key
    // (`TENSOL_OPENROUTER_API_KEY`) — resolved in the `.transform()` below, so
    // every consumer of `config.TENSOL_REVIEW_LLM_API_KEY` sees the effective
    // key. The default base URL + model already target OpenRouter, so the
    // shared `sk-or-v1-…` key works unchanged.
    TENSOL_REVIEW_LLM_API_KEY: z.string().default(""),
    TENSOL_REVIEW_LLM_BASE_URL: z
      .string()
      .default("https://openrouter.ai/api/v1"),
    TENSOL_REVIEW_LLM_MODEL: z.string().default("qwen/qwen3.7-max"),

    // Exploit Lab + Deep Research feature gates (migration 0013). Both default
    // OFF so the feature is dark until an operator opts in; the rest tune the
    // Lab's bounded autonomous loop (model, iteration cap, USD budget, sandbox
    // isolation, output-token price for budget accounting). z.coerce parses env
    // strings ("true"/"4"/"2.0") into the right primitive.
    TENSOL_EXPLOIT_ENABLED: z.coerce.boolean().default(false),
    TENSOL_RESEARCH_ENABLED: z.coerce.boolean().default(false),
    TENSOL_EXPLOIT_LLM_MODEL: z.string().default("qwen/qwen3.7-max"),
    TENSOL_EXPLOIT_MAX_ITERS: z.coerce.number().int().positive().default(4),
    TENSOL_EXPLOIT_BUDGET_USD: z.coerce.number().positive().default(2.0),
    TENSOL_EXPLOIT_SANDBOX: z.enum(["vm", "local"]).default("local"),
    TENSOL_EXPLOIT_USD_PER_MTOK_OUT: z.coerce.number().positive().default(2.0),

    PORT: z.coerce
      .number({ invalid_type_error: "PORT must be a number" })
      .int()
      .positive()
      .default(3000),

    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.EMAIL_PROVIDER === "resend" && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY is required when EMAIL_PROVIDER=resend",
      });
    }
  })
  // 003-whitebox — resolve the review LLM key fallback at load time. When the
  // review-specific key is unset, reuse the shared OpenRouter key so whitebox
  // scans + PR review activate without a duplicate credential. Returns a new
  // object (no mutation); the shape is unchanged, so `Config` is unaffected.
  .transform((cfg) => ({
    ...cfg,
    TENSOL_REVIEW_LLM_API_KEY:
      cfg.TENSOL_REVIEW_LLM_API_KEY || cfg.TENSOL_OPENROUTER_API_KEY,
  }));

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate env vars. Throws ZodError on invalid input — the
 * thrown error message includes the offending field name(s) so startup
 * logs surface the misconfiguration immediately.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const field = issue.path.join(".");
        return `${field}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return parsed.data;
}

let cachedConfig: Config | undefined;

/**
 * Lazy singleton config parsed from `process.env` on first access.
 *
 * Production code should call `getConfig()` at startup (e.g. in
 * `server.ts`) — that call will throw if any required env var is
 * missing/invalid, surfacing the misconfiguration in startup logs.
 *
 * The parse is memoised after first success so subsequent imports are
 * cheap. Tests should call `loadConfig(env)` directly with an injected
 * env record and never touch the singleton.
 */
export function getConfig(): Config {
  if (cachedConfig === undefined) {
    cachedConfig = loadConfig(
      process.env as Record<string, string | undefined>,
    );
  }
  return cachedConfig;
}
