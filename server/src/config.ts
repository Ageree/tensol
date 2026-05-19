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
  });

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
