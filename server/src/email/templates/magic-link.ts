/**
 * T024 — Magic-link email template.
 *
 * Renders a minimal, table-based HTML email plus a plain-text fallback.
 * Inline-only styling: every email client renders inline styles, while
 * `<style>` blocks and external CSS are unreliable across Gmail / Outlook /
 * Yahoo. No Tailwind, no CSS-in-JS — the template is deliberately a
 * pure-string function so it can be rendered with no runtime dependencies.
 *
 * The recipient `email` is HTML-escaped before interpolation. `verifyUrl`
 * is assumed to be a server-built URL (no user-controlled chars beyond the
 * opaque token), but we still escape `&`, `<`, `>`, `"`, `'` defensively
 * for the visible `<a>` text — never for the `href`, which would corrupt
 * URL encoding.
 */
export interface RenderMagicLinkArgs {
  readonly email: string;
  readonly verifyUrl: string;
  readonly expiresAtMs: number;
  readonly brand?: {
    readonly name?: string;
    readonly supportEmail?: string;
  };
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const DEFAULT_BRAND_NAME = "Sthrip";
const DEFAULT_SUPPORT_EMAIL = "support@sthrip.dev";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function minutesUntil(expiresAtMs: number, nowMs: number = Date.now()): number {
  const diff = expiresAtMs - nowMs;
  if (diff <= 0) return 0;
  return Math.max(1, Math.round(diff / 60000));
}

export function renderMagicLinkEmail(
  args: RenderMagicLinkArgs,
): RenderedEmail {
  const brandName = args.brand?.name ?? DEFAULT_BRAND_NAME;
  const supportEmail = args.brand?.supportEmail ?? DEFAULT_SUPPORT_EMAIL;
  const safeEmail = escapeHtml(args.email);
  const safeBrand = escapeHtml(brandName);
  const safeSupport = escapeHtml(supportEmail);
  // verifyUrl is interpolated as href verbatim (server-built, opaque token).
  // Only escape it when used as visible text to keep the URL-encoded form
  // intact in the href attribute.
  const safeVerifyHref = args.verifyUrl;
  const safeVerifyText = escapeHtml(args.verifyUrl);
  const minutes = minutesUntil(args.expiresAtMs);

  const subject = `Вход в ${brandName} — magic link`;

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${safeBrand}</title>
</head>
<body style="margin:0;padding:0;background:#0b0b0b;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0b0b;padding:32px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#141414;border:1px solid #262626;border-radius:8px;padding:32px;">
        <tr>
          <td style="padding-bottom:24px;font-size:14px;letter-spacing:2px;color:#8a8a8a;text-transform:uppercase;">${safeBrand}</td>
        </tr>
        <tr>
          <td style="padding-bottom:16px;font-size:22px;line-height:1.3;color:#ffffff;">Вход в ${safeBrand}</td>
        </tr>
        <tr>
          <td style="padding-bottom:24px;font-size:14px;line-height:1.6;color:#bdbdbd;">
            Запрошен вход для адреса <strong style="color:#ffffff;">${safeEmail}</strong>. Ссылка действительна ${minutes} минут.
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:24px;">
            <a href="${safeVerifyHref}" style="display:inline-block;background:#ffffff;color:#0b0b0b;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px;">Войти в ${safeBrand}</a>
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:16px;font-size:12px;line-height:1.5;color:#8a8a8a;">
            Если кнопка не открывается, скопируйте ссылку в браузер:<br>
            <span style="color:#bdbdbd;word-break:break-all;">${safeVerifyText}</span>
          </td>
        </tr>
        <tr>
          <td style="border-top:1px solid #262626;padding-top:16px;font-size:12px;line-height:1.5;color:#6f6f6f;">
            Если это были не вы — просто проигнорируйте письмо. Вопросы: <a href="mailto:${safeSupport}" style="color:#bdbdbd;text-decoration:underline;">${safeSupport}</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `Вход в ${brandName}`,
    "",
    `Запрошен вход для адреса ${args.email}. Ссылка действительна ${minutes} минут.`,
    "",
    `Откройте ссылку для входа:`,
    args.verifyUrl,
    "",
    `Если это были не вы — просто проигнорируйте это письмо.`,
    `Вопросы: ${supportEmail}`,
  ].join("\n");

  return { subject, html, text };
}
