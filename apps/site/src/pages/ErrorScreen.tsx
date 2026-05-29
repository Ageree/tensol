// Sthrip — E states (errors). Ported 1:1 from
// tensol-platform-design-v2/source/blocks/10_ReportsScreen.jsx ErrorState.
import { type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, HalftoneBg, Mono } from '../components/primitives';
import { useTensol } from '../context';

type Kind = '401' | '403' | '404' | '500' | 'offline';
const KNOWN: ReadonlyArray<Kind> = ['401', '403', '404', '500', 'offline'];
const isKind = (v: string | undefined): v is Kind =>
  v !== undefined && (KNOWN as ReadonlyArray<string>).includes(v);

interface Variant {
  readonly glyph: string;
  readonly title: string;
  readonly sub: string;
  readonly reason?: string;
  readonly cta: string;
  readonly route: string;
}

export default function ErrorScreen(): ReactElement {
  const { kind } = useParams<{ kind: string }>();
  const navigate = useNavigate();
  const { t } = useTensol();

  const resolved: Kind = isKind(kind) ? kind : '404';

  const map: Record<Kind, Variant> = {
    '401': { glyph: '401', title: t.err401Title, sub: t.err401Sub, cta: t.err401Cta, route: '/login' },
    '403': {
      glyph: '403',
      title: t.err403Title,
      sub: t.err403Sub,
      reason: t.err403Reason,
      cta: t.errCta,
      route: '/dashboard',
    },
    '404': {
      glyph: '404',
      title: t.err404Title,
      sub: t.err404Sub,
      cta: 'Back to dashboard',
      route: '/dashboard',
    },
    '500': {
      glyph: '5xx',
      title: t.err500Title,
      sub: t.err500Sub,
      cta: t.errCta,
      route: '/dashboard',
    },
    offline: {
      glyph: 'off',
      title: t.errOfflineTitle,
      sub: t.errOfflineSub,
      cta: t.errCta,
      route: '/dashboard',
    },
  };
  const e = map[resolved];

  const onCta = (): void => {
    if (resolved === 'offline') {
      window.location.reload();
      return;
    }
    navigate(e.route);
  };

  return (
    <AppShell breadcrumb={['Error']} role="security_lead" density="comfortable">
      <RouteHead title={`Error ${resolved} — Sthrip`} />
      <div
        data-screen-label={`13 App — error ${resolved}`}
        style={{
          minHeight: 480,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          padding: '40px 24px',
          textAlign: 'center',
        }}
      >
        <div style={{ position: 'relative', width: 200, height: 80 }}>
          <HalftoneBg size={6} opacity={0.4} color="var(--fg)" />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--paper)',
              margin: 8,
            }}
          >
            <Mono
              size={42}
              color="var(--red)"
              style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.04em' }}
            >
              {e.glyph}
            </Mono>
          </div>
        </div>
        <h2
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500,
            fontSize: 28,
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          {e.title}
        </h2>
        <p
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 14,
            color: 'var(--fg-2)',
            margin: 0,
            maxWidth: 460,
          }}
        >
          {e.sub}
        </p>
        {e.reason && (
          <div style={{ padding: '10px 14px', border: '1px dashed var(--red)', maxWidth: 460 }}>
            <Mono size={11} color="var(--red)">
              {e.reason}
            </Mono>
          </div>
        )}
        <Btn kind="primary" onClick={onCta}>
          {e.cta}
        </Btn>
      </div>
    </AppShell>
  );
}
