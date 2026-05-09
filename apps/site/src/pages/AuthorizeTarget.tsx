// Tensol — target authorization proof wizard (Sprint 27).
// 3-step flow: choose method → set up proof → verify.
import { type ReactElement, useEffect, useReducer } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Btn, Card, Mono, StatusChip } from '../components/primitives.tsx';
import { useTensol } from '../context.tsx';
import type { TensolDict } from '../i18n.ts';
import {
  type AuthMethod,
  type ChallengeData,
  copyToClipboard,
  getAuthStatus,
  pollOnce,
  startAuth,
  verifyAuth,
} from '../lib/authorize-api.ts';

// ─── State machine ────────────────────────────────────────────────────────────

type VerifyState = 'idle' | 'loading' | 'success' | 'failure' | 'polling';

interface AuthorizeState {
  step: 1 | 2 | 3;
  method: AuthMethod | null;
  challenge: ChallengeData | null;
  verifyState: VerifyState;
  errorReason: string | null;
  copiedDnsName: boolean;
  copiedDnsValue: boolean;
  copiedFileUrl: boolean;
  copiedFileBody: boolean;
}

export type AuthorizeAction =
  | { type: 'pickMethod'; method: AuthMethod }
  | { type: 'startSuccess'; challenge: ChallengeData }
  | { type: 'startFailure'; reason: string }
  | { type: 'goNext' }
  | { type: 'goBack' }
  | { type: 'verifyStart' }
  | { type: 'verifySuccess' }
  | { type: 'verifyFailure'; reason: string }
  | { type: 'pollTick' }
  | { type: 'setCopied'; field: 'dnsName' | 'dnsValue' | 'fileUrl' | 'fileBody'; value: boolean };

const initialState: AuthorizeState = {
  step: 1,
  method: null,
  challenge: null,
  verifyState: 'idle',
  errorReason: null,
  copiedDnsName: false,
  copiedDnsValue: false,
  copiedFileUrl: false,
  copiedFileBody: false,
};

export const reducer = (state: AuthorizeState, action: AuthorizeAction): AuthorizeState => {
  switch (action.type) {
    case 'pickMethod':
      return { ...state, method: action.method, errorReason: null };
    case 'startSuccess':
      return { ...state, challenge: action.challenge, step: 2, errorReason: null };
    case 'startFailure':
      return { ...state, errorReason: action.reason };
    case 'goNext':
      return { ...state, step: state.step < 3 ? ((state.step + 1) as 2 | 3) : state.step };
    case 'goBack':
      return {
        ...state,
        step: state.step > 1 ? ((state.step - 1) as 1 | 2) : state.step,
        verifyState: 'idle',
        errorReason: null,
      };
    case 'verifyStart':
      return { ...state, verifyState: 'loading', errorReason: null };
    case 'verifySuccess':
      return { ...state, verifyState: 'success', step: 3 };
    case 'verifyFailure':
      return { ...state, verifyState: 'failure', errorReason: action.reason };
    case 'pollTick':
      return state;
    case 'setCopied': {
      const key =
        `copied${action.field.charAt(0).toUpperCase()}${action.field.slice(1)}` as keyof AuthorizeState;
      return { ...state, [key]: action.value };
    }
    default:
      return state;
  }
};

// ─── Error message mapper ─────────────────────────────────────────────────────

const errorMessage = (reason: string | null, t: TensolDict): string => {
  if (!reason) return '';
  const map: Record<string, string> = {
    token_mismatch: t.authorize.errTokenMismatch,
    dns_lookup_error: t.authorize.errDnsLookup,
    unexpected_status: t.authorize.errStatus,
    non_https: t.authorize.errNonHttps,
    redirect_rejected: t.authorize.errRedirect,
    oversize: t.authorize.errOversize,
    timeout: t.authorize.errTimeout,
    privacy_proxy: t.authorize.errPrivacyProxy,
    token_expired: t.authorize.errExpired,
    too_many_attempts: t.authorize.errRateLimit,
    method_incompatible_kind: t.authorize.errMethodIncompatible,
  };
  return map[reason] ?? reason;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function AuthorizeTarget(): ReactElement {
  const { t } = useTensol();
  const navigate = useNavigate();
  const { projectId = 'UNKNOWN', targetId = 'UNKNOWN' } = useParams<{
    projectId: string;
    targetId: string;
  }>();
  const [searchParams] = useSearchParams();

  const [state, dispatch] = useReducer(reducer, initialState, (s) => {
    // If ?confirmed=1, start directly in success state
    if (searchParams.get('confirmed') === '1') {
      return { ...s, step: 3 as const, verifyState: 'success' as const };
    }
    return s;
  });

  // whois_email polling: 5s interval, up to 60 ticks (5 min)
  useEffect(() => {
    if (state.step !== 3 || state.method !== 'whois_email' || state.verifyState === 'success')
      return;
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
      dispatch({ type: 'pollTick' });
      void pollOnce(getAuthStatus, targetId, dispatch);
      if (ticks >= 60) clearInterval(id);
    }, 5000);
    return () => clearInterval(id);
  }, [state.step, state.method, state.verifyState, targetId]);

  const handlePickMethod = async (method: AuthMethod) => {
    dispatch({ type: 'pickMethod', method });
    const res = await startAuth(targetId, method);
    if (res.data) {
      dispatch({ type: 'startSuccess', challenge: res.data });
    } else {
      dispatch({ type: 'startFailure', reason: res.error ?? 'unknown' });
    }
  };

  const handleVerify = async () => {
    if (!state.method) return;
    dispatch({ type: 'verifyStart' });
    const res = await verifyAuth(targetId, state.method);
    if (res.data?.status === 'verified') {
      dispatch({ type: 'verifySuccess' });
    } else {
      dispatch({ type: 'verifyFailure', reason: res.data?.reason ?? res.error ?? 'unknown' });
    }
  };

  const handleCopy = (text: string, field: 'dnsName' | 'dnsValue' | 'fileUrl' | 'fileBody') => {
    void copyToClipboard(
      text,
      () => dispatch({ type: 'setCopied', field, value: true }),
      () => dispatch({ type: 'setCopied', field, value: false }),
    );
  };

  return (
    <AppShell breadcrumb={[t.authorize.pageTitle]}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem' }}>
        <h1 style={{ marginBottom: '1rem' }}>{t.authorize.pageTitle}</h1>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 8, marginBottom: '2rem' }}>
          {([1, 2, 3] as const).map((n) => (
            <div
              key={n}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: state.step >= n ? 'var(--ink, #0d1117)' : 'var(--border, #ccc)',
              }}
            />
          ))}
        </div>

        {/* Why accordion */}
        <details style={{ marginBottom: '1.5rem', fontSize: '0.875rem' }}>
          <summary style={{ cursor: 'pointer', opacity: 0.7 }}>{t.authorize.whyTitle}</summary>
          <p style={{ marginTop: 8, opacity: 0.7 }}>{t.authorize.whyBody}</p>
        </details>

        {/* ── Step 1: Choose method ── */}
        {state.step === 1 && (
          <div>
            <h2 style={{ marginBottom: '0.5rem' }}>{t.authorize.step1Title}</h2>
            <p style={{ opacity: 0.6, marginBottom: '1.5rem', fontSize: '0.875rem' }}>
              {t.authorize.step1Hint}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                {
                  method: 'dns_txt' as AuthMethod,
                  title: t.authorize.methodDnsTitle,
                  desc: t.authorize.methodDnsDesc,
                  time: t.authorize.methodDnsTime,
                },
                {
                  method: 'file_upload' as AuthMethod,
                  title: t.authorize.methodFileTitle,
                  desc: t.authorize.methodFileDesc,
                  time: t.authorize.methodFileTime,
                },
                {
                  method: 'whois_email' as AuthMethod,
                  title: t.authorize.methodEmailTitle,
                  desc: t.authorize.methodEmailDesc,
                  time: t.authorize.methodEmailTime,
                },
              ].map(({ method, title, desc, time }) => (
                <Card
                  key={method}
                  onClick={() => void handlePickMethod(method)}
                  style={{
                    cursor: 'pointer',
                    outline: state.method === method ? '2px solid var(--ink, #0d1117)' : 'none',
                    padding: '1rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{title}</div>
                      <div style={{ fontSize: '0.8rem', opacity: 0.6, marginTop: 4 }}>{desc}</div>
                    </div>
                    <Mono style={{ fontSize: '0.75rem', opacity: 0.5 }}>{time}</Mono>
                  </div>
                </Card>
              ))}
            </div>
            {state.errorReason && (
              <p style={{ color: 'var(--danger, #c0392b)', marginTop: 12, fontSize: '0.875rem' }}>
                {errorMessage(state.errorReason, t)}
              </p>
            )}
          </div>
        )}

        {/* ── Step 2: Instructions ── */}
        {state.step === 2 && state.challenge && (
          <div>
            <h2 style={{ marginBottom: '1rem' }}>{t.authorize.step2Title}</h2>

            {state.challenge.instructions.kind === 'dns_txt' &&
              state.challenge.instructions.txtRecord && (
                <div>
                  <p style={{ opacity: 0.6, fontSize: '0.875rem', marginBottom: '1rem' }}>
                    {t.authorize.step2HintDns}
                  </p>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: 4 }}>
                      Record name
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Mono style={{ flex: 1 }}>{state.challenge.instructions.txtRecord.name}</Mono>
                      <Btn
                        size="sm"
                        kind="ghost"
                        onClick={() =>
                          handleCopy(state.challenge?.instructions.txtRecord?.name ?? '', 'dnsName')
                        }
                      >
                        {state.copiedDnsName ? t.authorize.copied : t.authorize.copy}
                      </Btn>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: 4 }}>
                      Record value
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Mono style={{ flex: 1, wordBreak: 'break-all' }}>
                        {state.challenge.instructions.txtRecord.value}
                      </Mono>
                      <Btn
                        size="sm"
                        kind="ghost"
                        onClick={() =>
                          handleCopy(state.challenge?.instructions.txtRecord?.value ?? '', 'dnsValue')
                        }
                      >
                        {state.copiedDnsValue ? t.authorize.copied : t.authorize.copy}
                      </Btn>
                    </div>
                  </div>
                </div>
              )}

            {state.challenge.instructions.kind === 'file_upload' &&
              state.challenge.instructions.file && (
                <div>
                  <p style={{ opacity: 0.6, fontSize: '0.875rem', marginBottom: '1rem' }}>
                    {t.authorize.step2HintFile}
                  </p>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: 4 }}>
                      File URL
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Mono style={{ flex: 1, wordBreak: 'break-all' }}>
                        {state.challenge.instructions.file.url}
                      </Mono>
                      <Btn
                        size="sm"
                        kind="ghost"
                        onClick={() =>
                          handleCopy(state.challenge?.instructions.file?.url ?? '', 'fileUrl')
                        }
                      >
                        {state.copiedFileUrl ? t.authorize.copied : t.authorize.copy}
                      </Btn>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, marginBottom: 4 }}>
                      File contents
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Mono style={{ flex: 1 }}>{state.challenge.instructions.file.body}</Mono>
                      <Btn
                        size="sm"
                        kind="ghost"
                        onClick={() =>
                          handleCopy(state.challenge?.instructions.file?.body ?? '', 'fileBody')
                        }
                      >
                        {state.copiedFileBody ? t.authorize.copied : t.authorize.copy}
                      </Btn>
                    </div>
                  </div>
                </div>
              )}

            {state.challenge.instructions.kind === 'whois_email' &&
              state.challenge.instructions.email && (
                <div>
                  <p style={{ opacity: 0.6, fontSize: '0.875rem', marginBottom: '1rem' }}>
                    {t.authorize.step2HintEmail}
                  </p>
                  <Mono>{maskEmail(state.challenge.instructions.email.recipient)}</Mono>
                </div>
              )}

            <div style={{ display: 'flex', gap: 12, marginTop: '2rem' }}>
              <Btn kind="ghost" onClick={() => dispatch({ type: 'goBack' })}>
                {t.authorize.back}
              </Btn>
              <Btn onClick={() => dispatch({ type: 'goNext' })}>{t.authorize.next}</Btn>
            </div>
          </div>
        )}

        {/* ── Step 3: Verify ── */}
        {state.step === 3 && (
          <div>
            <h2 style={{ marginBottom: '1rem' }}>{t.authorize.step3Title}</h2>

            {state.verifyState === 'success' && (
              <div>
                <StatusChip status={t.authorize.step3Success} tone="ok" />
                <div style={{ marginTop: '1.5rem' }}>
                  <Btn onClick={() => navigate(`/projects/${projectId}/targets/${targetId}`)}>
                    {t.authorize.goToScan}
                  </Btn>
                </div>
              </div>
            )}

            {state.verifyState !== 'success' && state.method !== 'whois_email' && (
              <div>
                <Btn onClick={() => void handleVerify()} disabled={state.verifyState === 'loading'}>
                  {state.verifyState === 'loading' ? '…' : t.authorize.step3Run}
                </Btn>
                {state.verifyState === 'failure' && state.errorReason && (
                  <div style={{ marginTop: 12 }}>
                    <StatusChip status={errorMessage(state.errorReason, t)} tone="danger" />
                  </div>
                )}
              </div>
            )}

            {state.verifyState !== 'success' && state.method === 'whois_email' && (
              <div>
                <p style={{ opacity: 0.6, marginBottom: '1rem' }}>{t.authorize.step3Polling}</p>
                <Btn onClick={() => void pollOnce(getAuthStatus, targetId, dispatch)}>
                  {t.authorize.step3PollNow}
                </Btn>
              </div>
            )}

            {state.verifyState !== 'success' && (
              <div style={{ marginTop: '1.5rem' }}>
                <Btn kind="ghost" onClick={() => dispatch({ type: 'goBack' })}>
                  {t.authorize.back}
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return `${email[0]}***@${email.slice(at + 1)}`;
};
