// /contact — lead intake screen. Split-panel ink-aside + paper form.
import { useMemo, useState, type FormEvent } from 'react';
import { RouteHead } from '../components/RouteHead.tsx';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { AuthWave } from '../components/PixelWaveBg.tsx';
import {
  Btn,
  Checkbox,
  Eyebrow,
  Field,
  HalftoneBg,
  Input,
  LogoLockup,
  Mono,
  Segmented,
  Select,
  Textarea,
} from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

/* ─────────────────────────────────────────────────────────────────────
   Free-mail blocklist — corp emails only.
   ───────────────────────────────────────────────────────────────────── */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'mail.ru',
  'list.ru',
  'bk.ru',
  'inbox.ru',
  'yandex.ru',
  'yandex.com',
  'ya.ru',
  'rambler.ru',
  'icloud.com',
  'me.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'yahoo.com',
]);

const isCorpEmail = (email: string): boolean => {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return !FREE_MAIL_DOMAINS.has(domain);
};

/* ─────────────────────────────────────────────────────────────────────
   Form state types
   ───────────────────────────────────────────────────────────────────── */
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

type FormShape = {
  name: string;
  email: string;
  company: string;
  role: string;
  size: string;
  scope: string;
  urgency: string;
  phone: string;
  consent: boolean;
};

type FieldErrors = Partial<Record<keyof FormShape, string>>;

/* ─────────────────────────────────────────────────────────────────────
   Telegram-message formatter (markdown)
   ───────────────────────────────────────────────────────────────────── */
const formatPayloadMessage = (f: FormShape): string => {
  return [
    '🐎 Tensol — new lead',
    '',
    `${f.name} · ${f.role} @ ${f.company} (${f.size})`,
    `✉ ${f.email}`,
    `📞 ${f.phone || '—'}`,
    `⏱ ${f.urgency}`,
    '',
    'Scope:',
    f.scope,
  ].join('\n');
};

/* ─────────────────────────────────────────────────────────────────────
   Component
   ───────────────────────────────────────────────────────────────────── */
export default function Contact() {
  const { t } = useTensol();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormShape>({
    name: '',
    email: '',
    company: '',
    role: t.contact.fRoleOptions[0] ?? '',
    size: t.contact.fSizeOptions[0] ?? '',
    scope: '',
    urgency: t.contact.fUrgencyOptions[0] ?? '',
    phone: '',
    consent: false,
  });

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorFallback, setErrorFallback] = useState<{ telegramOpened: boolean }>({
    telegramOpened: false,
  });

  // Build the zod schema once per locale (errRequired/errInvalidEmail/errConsent reads from t).
  const schema = useMemo(() => {
    return z.object({
      name: z.string().trim().min(1, t.contact.errRequired),
      email: z
        .string()
        .trim()
        .min(1, t.contact.errRequired)
        .email(t.contact.errInvalidEmail)
        .refine(isCorpEmail, { message: t.contact.errInvalidEmail }),
      company: z.string().trim().min(1, t.contact.errRequired),
      role: z.string().trim().min(1, t.contact.errRequired),
      size: z.string().trim().min(1, t.contact.errRequired),
      scope: z.string().trim().min(1, t.contact.errRequired),
      urgency: z.string().trim().min(1, t.contact.errRequired),
      phone: z.string().trim().optional().default(''),
      consent: z.literal(true, { message: t.contact.errConsent }),
    });
  }, [t]);

  const update = <K extends keyof FormShape>(key: K, value: FormShape[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();

    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      const fieldErrs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormShape | undefined;
        if (key && !fieldErrs[key]) fieldErrs[key] = issue.message;
      }
      setErrors(fieldErrs);
      return;
    }

    setSubmitState('submitting');
    setErrors({});

    const endpoint = import.meta.env.VITE_CONTACT_ENDPOINT;
    const handle = import.meta.env.VITE_CONTACT_TELEGRAM_HANDLE;

    let delivered = false;
    if (endpoint) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(form),
        });
        delivered = res.ok;
      } catch {
        delivered = false;
      }
    }

    if (delivered) {
      setSubmitState('success');
      return;
    }

    // Fallback path: open Telegram deep-link (if configured) and show error state.
    let telegramOpened = false;
    if (handle && typeof window !== 'undefined') {
      const url = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(
        formatPayloadMessage(form),
      )}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      telegramOpened = true;
    }
    setErrorFallback({ telegramOpened });
    setSubmitState('error');
  };

  const mailto = useMemo(() => {
    const to = import.meta.env.VITE_CONTACT_MAILTO ?? 'nikto256@gmail.com';
    const subject = encodeURIComponent('Tensol lead');
    const body = encodeURIComponent(formatPayloadMessage(form));
    return `mailto:${to}?subject=${subject}&body=${body}`;
  }, [form]);

  const urgencyOpts = useMemo(
    () =>
      t.contact.fUrgencyOptions.map((label) => ({
        value: label,
        label: <span style={{ whiteSpace: 'nowrap' }}>{label}</span>,
      })),
    [t.contact.fUrgencyOptions],
  );

  /* ───── Layout ───── */
  return (
    <>
      <RouteHead
        title="Contact — Tensol"
        description="Request a scoped penetration testing engagement. Tell us about your stack."
        ogTitle="Contact — Tensol"
        ogDescription="Request a scoped penetration testing engagement. Tell us about your stack."
        ogImage="/assets/tensol-horse-red.svg"
      />
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        color: 'var(--ink)',
        display: 'grid',
        gridTemplateColumns: '1.1fr 1fr',
      }}
    >
      {/* Left: ink-aside with halftone + wave + founder quote */}
      <aside
        style={{
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--ink)',
          color: 'var(--paper)',
          padding: '40px 48px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <HalftoneBg color="var(--paper)" opacity={0.08} />
        <AuthWave />

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--paper)',
              cursor: 'pointer',
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <LogoLockup size={20} color="var(--paper)" onClick={() => navigate('/')} />
          </button>
        </div>

        <div style={{ position: 'relative', maxWidth: 520 }}>
          <Eyebrow color="rgba(250,249,246,.55)" style={{ marginBottom: 20 }}>
            {t.contact.asideMeta}
          </Eyebrow>
          <p
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontStyle: 'italic',
              fontWeight: 400,
              fontSize: 30,
              lineHeight: 1.18,
              letterSpacing: '-0.01em',
              color: 'var(--paper)',
              margin: 0,
            }}
          >
            {t.contact.asideQuote}
          </p>
          <div
            style={{
              marginTop: 28,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'rgba(250,249,246,.55)',
              letterSpacing: '0.04em',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>// founder reply · &lt; 1h</span>
            <span>v0.4.1 · build a8c7d2</span>
          </div>
        </div>
      </aside>

      {/* Right: paper form panel */}
      <main
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: '40px',
          overflowY: 'auto',
        }}
      >
        <div style={{ position: 'absolute', top: 32, right: 40 }}>
          <LangSwitcher />
        </div>

        <div style={{ width: '100%', maxWidth: 520, marginTop: 24 }}>
          {submitState === 'success' ? (
            <SuccessPanel onBack={() => navigate('/')} />
          ) : (
            <>
              <Eyebrow style={{ marginBottom: 12 }}>{t.contact.eyebrow}</Eyebrow>
              <h1
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: 44,
                  lineHeight: 1.05,
                  letterSpacing: '-0.02em',
                  margin: '0 0 12px',
                }}
              >
                {t.contact.title}
              </h1>
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 14.5,
                  lineHeight: 1.5,
                  color: 'var(--fg-2)',
                  margin: '0 0 28px',
                  maxWidth: '52ch',
                }}
              >
                {t.contact.sub}
              </p>

              <form
                onSubmit={onSubmit}
                noValidate
                data-screen-label="contact"
                style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              >
                <Field label={t.contact.fName} error={errors.name}>
                  <Input
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    autoComplete="name"
                    error={Boolean(errors.name)}
                    placeholder="Alex Karpov"
                  />
                </Field>

                <Field
                  label={t.contact.fEmail}
                  hint={t.contact.fEmailHint}
                  error={errors.email}
                >
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => update('email', e.target.value)}
                    autoComplete="email"
                    error={Boolean(errors.email)}
                    placeholder="you@company.com"
                  />
                </Field>

                <Field label={t.contact.fCompany} error={errors.company}>
                  <Input
                    value={form.company}
                    onChange={(e) => update('company', e.target.value)}
                    autoComplete="organization"
                    error={Boolean(errors.company)}
                    placeholder="Acme Bank"
                  />
                </Field>

                <Field label={t.contact.fRole} error={errors.role}>
                  <Select
                    value={form.role}
                    onChange={(v) => update('role', v)}
                    options={t.contact.fRoleOptions}
                  />
                </Field>

                <Field label={t.contact.fSize} error={errors.size}>
                  <Select
                    value={form.size}
                    onChange={(v) => update('size', v)}
                    options={t.contact.fSizeOptions}
                  />
                </Field>

                <Field
                  label={t.contact.fScope}
                  hint={t.contact.fScopeHint}
                  error={errors.scope}
                >
                  <Textarea
                    rows={4}
                    value={form.scope}
                    onChange={(e) => update('scope', e.target.value)}
                    error={Boolean(errors.scope)}
                    placeholder="Two prod web apps + admin + REST API. ~600 endpoints. Quarterly cadence."
                  />
                </Field>

                <Field label={t.contact.fUrgency} error={errors.urgency}>
                  <div>
                    <Segmented
                      options={urgencyOpts}
                      value={form.urgency}
                      onChange={(v) => update('urgency', v)}
                      size="sm"
                    />
                  </div>
                </Field>

                <Field label={t.contact.fPhone} error={errors.phone}>
                  <Input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => update('phone', e.target.value)}
                    autoComplete="tel"
                    placeholder="+7 999 123-45-67"
                  />
                </Field>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Checkbox
                    checked={form.consent}
                    onChange={(v) => update('consent', v)}
                    label={
                      <span>
                        {t.contact.fConsent}{' '}
                        <Link
                          to="/legal/privacy"
                          style={{
                            color: 'var(--fg)',
                            textDecoration: 'underline',
                            textUnderlineOffset: 3,
                          }}
                        >
                          {t.contact.fConsentLink}
                        </Link>
                        .
                      </span>
                    }
                    danger={Boolean(errors.consent)}
                  />
                  {errors.consent && (
                    <Mono size={11} color="var(--red)">
                      {errors.consent}
                    </Mono>
                  )}
                </div>

                {submitState === 'error' && (
                  <div
                    style={{
                      padding: '12px 14px',
                      border: '1px solid var(--red)',
                      color: 'var(--red)',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      lineHeight: 1.5,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <strong style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                      [fail] {t.contact.errorTitle}
                    </strong>
                    {errorFallback.telegramOpened && <span>{t.contact.errorTelegramFallback}</span>}
                    <a
                      href={mailto}
                      style={{
                        color: 'var(--red)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 3,
                      }}
                    >
                      {t.contact.errorMailto} →
                    </a>
                  </div>
                )}

                <SubmitButton
                  submitting={submitState === 'submitting'}
                  label={submitState === 'submitting' ? t.contact.submitting : t.contact.submit}
                />
              </form>
            </>
          )}
        </div>
      </main>
    </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sub-component: success state
   ───────────────────────────────────────────────────────────────────── */
function SuccessPanel({ onBack }: { onBack: () => void }) {
  const { t } = useTensol();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 32 }}>
      <Eyebrow>// SENT</Eyebrow>
      <h1
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          fontSize: 44,
          lineHeight: 1.05,
          letterSpacing: '-0.02em',
          margin: 0,
        }}
      >
        {t.contact.successTitle}
      </h1>
      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 14.5,
          lineHeight: 1.5,
          color: 'var(--fg-2)',
          margin: 0,
          maxWidth: '52ch',
        }}
      >
        {t.contact.successSub}
      </p>
      <div>
        <Btn kind="secondary" onClick={onBack}>
          ← {t.contact.successBack}
        </Btn>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sub-component: real type="submit" button (Btn renders type="button")
   ───────────────────────────────────────────────────────────────────── */
function SubmitButton({ submitting, label }: { submitting: boolean; label: string }) {
  const [hov, setHov] = useState(false);
  const base = {
    fontFamily: "'JetBrains Mono', monospace" as const,
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    padding: '9px 14px',
    border: '1px solid var(--fg)',
    borderRadius: 0,
    cursor: submitting ? 'not-allowed' : 'pointer',
    opacity: submitting ? 0.4 : 1,
    transition: 'all 120ms cubic-bezier(.22,1,.36,1)',
    display: 'inline-flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
    width: '100%',
    background: hov && !submitting ? 'var(--bg)' : 'var(--fg)',
    color: hov && !submitting ? 'var(--fg)' : 'var(--bg)',
  };
  return (
    <button
      type="submit"
      disabled={submitting}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={base}
    >
      {label} →
    </button>
  );
}
