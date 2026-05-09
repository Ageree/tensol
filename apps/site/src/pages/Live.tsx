// Tensol — C6 Live assessment. Ported 1:1 from
// tensol-platform-design-v2/source/blocks/08_LiveScreen.jsx LiveScreen.
import { useEffect, useState, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Mono, Scroll, StatusChip } from '../components/primitives';
import { useTensol } from '../context';
import { TENSOL_DATA, type LiveEventKind } from '../data';

const EVENT_TONES: Record<LiveEventKind, string> = {
  ok: 'var(--fg)',
  fail: 'var(--red)',
  wait: 'var(--fg-3)',
  warn: '#B8860B',
  sum: 'var(--fg)',
};

const EVENT_TAGS: Record<LiveEventKind, string> = {
  ok: '[ok]  ',
  fail: '[fail]',
  wait: '[wait]',
  warn: '[warn]',
  sum: '[sum] ',
};

export default function Live(): ReactElement {
  const { t } = useTensol();
  const role = 'security_lead';
  const a = TENSOL_DATA.assessments[0]!; // a1 — running
  const [paused, setPaused] = useState(false);
  const [, setProgress] = useState(a.progress);

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      setProgress((p) => Math.min(0.92, p + 0.005));
    }, 1200);
    return () => window.clearInterval(id);
  }, [paused]);

  const isOperator = (role as string) === 'operator' || (role as string) === 'security_lead';

  return (
    <AppShell
      breadcrumb={[t.navAssessments, TENSOL_DATA.assessments[0]!.id]}
      role="security_lead"
      density="comfortable"
    >
      <RouteHead title="Live Assessment — Tensol" />
      <div data-screen-label="09 App — live assessment">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 32,
          }}
        >
          <div>
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
              {t.liveTitle}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <StatusChip
                status={paused ? 'paused' : `${a.phase} · live`}
                tone={paused ? 'warn' : 'ok'}
              />
              <Mono size={11} color="var(--fg-3)">
                {a.name} · started {a.startedAt} · 4h 42m elapsed
              </Mono>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn
              kind="secondary"
              disabled={!isOperator}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? t.liveResume : t.livePause}
            </Btn>
            <Btn kind="red" disabled={!isOperator}>
              {t.liveCancel}
            </Btn>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 48 }}>
          <section>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: '1px solid var(--fg)',
              }}
            >
              <Mono
                size={11}
                color="var(--fg)"
                style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                timeline
              </Mono>
              <Mono size={11} color="var(--fg-3)">
                {paused ? '— paused —' : 'live · ws connected'}
              </Mono>
            </div>
            <Scroll maxHeight={520}>
              <div style={{ padding: '8px 0' }}>
                {TENSOL_DATA.liveEvents.map((e, i) => (
                  <div
                    key={`${e.t}-${i}`}
                    style={{
                      padding: '5px 0',
                      display: 'grid',
                      gridTemplateColumns: '64px 56px 1fr',
                      gap: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11.5,
                    }}
                  >
                    <span style={{ color: 'var(--fg-3)' }}>{e.t}</span>
                    <span style={{ color: EVENT_TONES[e.kind], fontWeight: 500 }}>
                      {EVENT_TAGS[e.kind]}
                    </span>
                    <span style={{ color: 'var(--fg-2)' }}>{e.m}</span>
                  </div>
                ))}
                {!paused && (
                  <div
                    style={{
                      padding: '5px 0',
                      display: 'grid',
                      gridTemplateColumns: '64px 56px 1fr',
                      gap: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11.5,
                    }}
                  >
                    <span style={{ color: 'var(--fg-3)' }}>13:48:34</span>
                    <span style={{ color: 'var(--fg-3)' }}>[…]  </span>
                    <span style={{ color: 'var(--fg-3)' }}>
                      browser.session.next · /api/v3/transfers{' '}
                      <span style={{ background: 'var(--fg)', color: 'var(--bg)' }}>▌</span>
                    </span>
                  </div>
                )}
              </div>
            </Scroll>
          </section>

          <section>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 12,
                paddingBottom: 8,
                borderBottom: '1px solid var(--red)',
              }}
            >
              <Mono
                size={11}
                color="var(--red)"
                style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                {t.liveHITL.replace('// ', '')} · 1
              </Mono>
            </div>
            {TENSOL_DATA.approvals.slice(0, 1).map((h) => (
              <div key={h.id} style={{ padding: '4px 0' }}>
                <div
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 14.5,
                    color: 'var(--fg)',
                    marginBottom: 6,
                  }}
                >
                  {h.detail}
                </div>
                <Mono size={10.5} color="var(--fg-3)" style={{ display: 'block' }}>
                  target {h.target} · requested {h.when}
                </Mono>
                <p
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    fontSize: 13,
                    color: 'var(--fg-2)',
                    marginTop: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {h.justify}
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <Btn size="sm" kind="primary" disabled={(role as string) !== 'security_lead'}>
                    Approve
                  </Btn>
                  <Btn size="sm" kind="dim">
                    Deny
                  </Btn>
                </div>
              </div>
            ))}

            <div
              style={{
                marginTop: 48,
                paddingTop: 16,
                borderTop: '1px solid var(--line-soft)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Mono size={10.5} color="var(--fg-3)">
                arms in 2 keypresses · halts all jobs
              </Mono>
              <Btn kind="red" size="sm" disabled={!isOperator}>
                Arm kill-switch
              </Btn>
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
