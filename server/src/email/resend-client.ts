/**
 * T024 — Email delivery client.
 *
 * Two delivery modes, selected at construction time:
 *
 *   - `stdout` — prints the rendered email to an injectable `logger`
 *     (default `console.log`). Used in development and tests so devs see
 *     magic links in the terminal without provisioning a Resend account.
 *
 *   - `resend` — invokes the Resend HTTP API via the official SDK. The
 *     real `Resend` constructor is dependency-injected through `sdkFactory`
 *     so unit tests can substitute a mock without `mock.module` flake.
 *
 * Constitution VII (deterministic boot) — required configuration is
 * validated at creation time, not first call. A `resend` client with no
 * API key throws synchronously from `createEmailClient`, surfacing the
 * misconfiguration in startup logs rather than at the first send.
 */
import { Resend } from "resend";
import { ulid } from "../lib/ids.ts";

export type EmailMode = "stdout" | "resend";

export interface EmailSendArgs {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
}

export interface EmailSendResult {
  readonly id: string;
}

export interface EmailClient {
  send(args: EmailSendArgs): Promise<EmailSendResult>;
}

/**
 * Structural type for the Resend SDK surface we depend on. Keeping this
 * narrow (just `emails.send`) lets test doubles satisfy it without
 * implementing the full Resend API.
 */
export interface ResendSdkLike {
  readonly emails: {
    send: (payload: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text?: string;
    }) => Promise<{
      data: { id: string } | null;
      error: unknown;
    }>;
  };
}

export interface CreateEmailClientOpts {
  readonly mode: EmailMode;
  readonly resendApiKey?: string;
  readonly from?: string;
  readonly logger?: (line: string) => void;
  readonly sdkFactory?: (apiKey: string) => ResendSdkLike;
}

const DEFAULT_FROM = "Sthrip <no-reply@sthrip.dev>";

function createStdoutClient(
  logger: (line: string) => void,
): EmailClient {
  return {
    async send(args) {
      const id = `stdout-${ulid()}`;
      logger(
        [
          "─── sthrip email (stdout mode) ───",
          `to:      ${args.to}`,
          `subject: ${args.subject}`,
          `id:      ${id}`,
          "── html ──",
          args.html,
          ...(args.text ? ["── text ──", args.text] : []),
          "──────────────────────────────────",
        ].join("\n"),
      );
      return { id };
    },
  };
}

function createResendClient(
  sdk: ResendSdkLike,
  from: string,
): EmailClient {
  return {
    async send(args) {
      const payload: {
        from: string;
        to: string;
        subject: string;
        html: string;
        text?: string;
      } = {
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
      };
      if (args.text !== undefined) {
        payload.text = args.text;
      }
      const result = await sdk.emails.send(payload);

      if (result.error || !result.data) {
        const detail =
          result.error && typeof result.error === "object"
            ? JSON.stringify(result.error)
            : String(result.error);
        throw new Error(`Resend send failed: ${detail}`);
      }

      return { id: result.data.id };
    },
  };
}

/**
 * Build an EmailClient. Fails fast on misconfiguration (Constitution VII).
 *
 * @throws Error if `mode === "resend"` and `resendApiKey` is missing/empty.
 */
export function createEmailClient(opts: CreateEmailClientOpts): EmailClient {
  const logger = opts.logger ?? ((line) => process.stdout.write(`${line}\n`));

  if (opts.mode === "stdout") {
    return createStdoutClient(logger);
  }

  if (!opts.resendApiKey || opts.resendApiKey.length === 0) {
    throw new Error(
      "RESEND_API_KEY is required when EMAIL_PROVIDER=resend (resendApiKey was empty)",
    );
  }

  const factory =
    opts.sdkFactory ?? ((apiKey: string) => new Resend(apiKey) as ResendSdkLike);
  const sdk = factory(opts.resendApiKey);
  const from = opts.from ?? DEFAULT_FROM;

  return createResendClient(sdk, from);
}
