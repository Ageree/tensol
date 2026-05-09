import type { Mailer } from './whois-verifier.ts';

export class LoggingMailer implements Mailer {
  async send(args: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    traceId: string;
  }): Promise<{ messageId: string }> {
    const redacted = args.textBody.replace(/token=[a-f0-9]{64}/gi, 'token=***');
    process.stderr.write(
      `[LoggingMailer] traceId=${args.traceId} to=${args.to} subject="${args.subject}"\n${redacted}\n`,
    );
    return { messageId: `log-${args.traceId}` };
  }
}

export class SmtpMailer implements Mailer {
  private constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly user: string,
    private readonly pass: string,
    private readonly from: string,
  ) {}

  static fromEnv(): SmtpMailer | null {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;
    return new SmtpMailer(SMTP_HOST, Number(SMTP_PORT), SMTP_USER, SMTP_PASS, SMTP_FROM);
  }

  async send(args: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    traceId: string;
  }): Promise<{ messageId: string }> {
    // Lazy import to avoid loading nodemailer at startup when SMTP is unconfigured.
    // @ts-expect-error — nodemailer is an optional runtime dependency
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      auth: { user: this.user, pass: this.pass },
    });
    const info = await transporter.sendMail({
      from: this.from,
      to: args.to,
      subject: args.subject,
      text: args.textBody,
      html: args.htmlBody,
    });
    return { messageId: String(info.messageId) };
  }
}
