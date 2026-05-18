// /contact — lead intake screen. Single paper panel, telegram + phone only.
import { useMemo, useState, type FormEvent } from 'react';
import { RouteHead } from '../components/RouteHead.tsx';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { LangSwitcher } from '../components/LangSwitcher.tsx';
import { AuthWave } from '../components/PixelWaveBg.tsx';
import {
  Btn,
  Checkbox,
  Field,
  HalftoneBg,
  Input,
  LogoLockup,
  Mono,
} from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';

/* ─────────────────────────────────────────────────────────────────────
   Form state types
   ───────────────────────────────────────────────────────────────────── */
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

type FormShape = {
  name: string;
  telegram: string;
  phone: string;
  consent: boolean;
};

type FieldErrors = Partial<Record<keyof FormShape, string>>;

/* ─────────────────────────────────────────────────────────────────────
   Telegram-handle normalizer (accept @handle, t.me/handle, bare handle).
   ───────────────────────────────────────────────────────────────────── */
const normalizeTelegram = (raw: string): string => {
  let v = raw.trim();
  v = v.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
  if (v.startsWith('@')) v = v.slice(1);
  return v;
};

const isValidTelegram = (raw: string): boolean => {
  const v = normalizeTelegram(raw);
  return /^[A-Za-z0-9_]{4,32}$/.test(v);
};

const isValidPhone = (raw: string): boolean => {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
};

/* ─────────────────────────────────────────────────────────────────────
   Telegram-message formatter (markdown)
   ───────────────────────────────────────────────────────────────────── */
const formatPayloadMessage = (f: FormShape): string => {
  const tg = normalizeTelegram(f.telegram);
  return [
    '🐎 Tensol — new lead',
    '',
    f.name,
    `✈ @${tg}`,
    `📞 ${f.phone}`,
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
    telegram: '',
    phone: '',
    consent: false,
  });

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorFallback, setErrorFallback] = useState<{ telegramOpened: boolean }>({
    telegramOpened: false,
  });

  const schema = useMemo(() => {
    return z.object({
      name: z.string().trim().min(1, t.contact.errRequired),
      telegram: z
        .string()
        .trim()
        .min(1, t.contact.errRequired)
        .refine(isValidTelegram, { message: t.contact.errInvalidTelegram }),
      phone: z
        .string()
        .trim()
        .min(1, t.contact.errRequired)
        .refine(isValidPhone, { message: t.contact.errInvalidPhone }),
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

    const payload = {
      ...form,
      telegram: normalizeTelegram(form.telegram),
    };

    let delivered = false;
    if (endpoint) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
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

    let telegramOpened = false;
    if (handle && typeof window !== 'undefined') {
      const url = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(
        formatPayloadMessage(payload),
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
        {/* Left: ink-aside with halftone + wave (no quote) */}
        <aside
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'var(--ink)',
            color: 'var(--paper)',
            padding: '40px 48px',
            display: 'flex',
            flexDirection: 'column',
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
                <h1
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 500,
                    fontSize: 44,
                    lineHeight: 1.05,
                    letterSpacing: '-0.02em',
                    margin: '0 0 28px',
                  }}
                >
                  {t.contact.title}
                </h1>

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
                    label={t.contact.fTelegram}
                    hint={t.contact.fTelegramHint}
                    error={errors.telegram}
                  >
                    <Input
                      value={form.telegram}
                      onChange={(e) => update('telegram', e.target.value)}
                      autoComplete="username"
                      error={Boolean(errors.telegram)}
                      placeholder="@yourhandle"
                    />
                  </Field>

                  <Field label={t.contact.fPhone} error={errors.phone}>
                    <Input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => update('phone', e.target.value)}
                      autoComplete="tel"
                      error={Boolean(errors.phone)}
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
                      {errorFallback.telegramOpened && (
                        <span>{t.contact.errorTelegramFallback}</span>
                      )}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 56, paddingTop: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-start',
          animation: 'tensol-horse-bounce 1.6s cubic-bezier(.22,1,.36,1) infinite',
        }}
      >
        <img
          src="/assets/horse-success.jpg"
          alt=""
          aria-hidden="true"
          style={{
            width: 360,
            maxWidth: '100%',
            height: 'auto',
            display: 'block',
            mixBlendMode: 'multiply',
            imageRendering: 'pixelated',
          }}
        />
      </div>
      <style>{`
        @keyframes tensol-horse-bounce {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-6px); }
        }
      `}</style>
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
