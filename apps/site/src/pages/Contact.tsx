// /contact — lead intake screen. Single paper panel, telegram + phone only.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { RouteHead } from '../components/RouteHead.tsx';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  Btn,
  Checkbox,
  Field,
  Input,
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

function ContactAsciiWave() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const el = preRef.current;
    if (!wrap || !el) return;

    let cols = 86;
    let rows = 24;
    const chars = ' .:-=+*#%@';
    let raf = 0;
    let lastDraw = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const style = getComputedStyle(el);
      const fontSize = Number.parseFloat(style.fontSize) || 9;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.05;
      const charWidth = fontSize * 0.62;
      cols = Math.max(64, Math.min(150, Math.ceil(rect.width / charWidth)));
      rows = Math.max(34, Math.min(110, Math.ceil(rect.height / lineHeight)));
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const render = (now: number) => {
      if (!lastDraw || now - lastDraw > 66) {
        const t = now / 1000;
        const lines: string[] = [];
        for (let y = 0; y < rows; y++) {
          let line = '';
          for (let x = 0; x < cols; x++) {
            const v =
              Math.sin(x * 0.22 + t * 0.9) +
              Math.sin(y * 0.3 - t * 0.7) +
              Math.sin(x * 0.1 + y * 0.14 + t * 0.4);
            const n = v / 3;
            if (n > 0.2) {
              const strength = Math.min(1, (n - 0.2) * 2.35);
              line += chars[Math.max(1, Math.floor(strength * (chars.length - 1)))];
            } else {
              line += ' ';
            }
          }
          lines.push(line.replace(/\s+$/g, ''));
        }
        el.textContent = lines.join('\n');
        lastDraw = now;
      }

      if (!reducedMotion) {
        raf = requestAnimationFrame(render);
      }
    };

    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="contact-ascii-wave" aria-hidden="true">
      <pre ref={preRef} />
    </div>
  );
}

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
    'STHRIP — new assessment request',
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
    const subject = encodeURIComponent('Sthrip assessment request');
    const body = encodeURIComponent(formatPayloadMessage(form));
    return `mailto:${to}?subject=${subject}&body=${body}`;
  }, [form]);

  /* ───── Layout ───── */
  return (
    <>
      <RouteHead
        title="Contact — Sthrip"
        description="Book a blackbox, whitebox, or continuous code-review security assessment with Sthrip."
        ogTitle="Contact — Sthrip"
        ogDescription="Book a blackbox, whitebox, or continuous code-review security assessment with Sthrip."
        ogImage="/assets/sthrip-noise-field.jpg"
      />
      <div
        className="contact-shell"
        style={{
          minHeight: '100vh',
          background: 'var(--paper)',
          color: 'var(--ink)',
          display: 'grid',
          gridTemplateColumns: '1.1fr 1fr',
        }}
      >
        {/* Left: brand signal panel */}
        <aside
          className="contact-theme-aside"
          style={{
            position: 'relative',
            overflow: 'hidden',
            padding: '40px 48px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="contact-aurora-grid" aria-hidden="true" />
          <ContactAsciiWave />

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => navigate('/')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--ink)',
                cursor: 'pointer',
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <img
                src="/assets/tensol-logo-mark-white.png"
                alt=""
                aria-hidden="true"
                style={{
                  display: 'block',
                  width: 34,
                  height: 34,
                  filter: 'invert(1) brightness(0.12)',
                }}
              />
              <img
                src="/assets/sthrip-wordmark-white.png"
                alt="STHRIP"
                style={{
                  display: 'block',
                  width: 126,
                  height: 'auto',
                  filter: 'invert(1) brightness(0.12)',
                }}
              />
            </button>
          </div>
          <div className="contact-left-copy">
            <span>SECURE INTAKE</span>
            <strong>Scope first. Evidence next.</strong>
            <p>
              Share a reachable contact. We will align the right blackbox,
              whitebox, or PR review path before any testing begins.
            </p>
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
          <div style={{ width: '100%', maxWidth: 520, marginTop: 24 }}>
            {submitState === 'success' ? (
              <SuccessPanel onBack={() => navigate('/')} />
            ) : (
              <>
                <h1
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 500,
                    fontSize: 44,
                    lineHeight: 1.05,
                    letterSpacing: 0,
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
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: 44,
          lineHeight: 1.05,
          letterSpacing: 0,
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
