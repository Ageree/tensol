// Tensol — C5 Approval. Ported 1:1 from
// tensol-platform-design-v2/source/blocks/07_HIGH.jsx ApprovalScreen.
import { type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Card, Checkbox, Eyebrow, Mono, StatusChip } from '../components/primitives';
import { useTensol } from '../context';

function Section({ h, children }: { h: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <Eyebrow style={{ marginBottom: 8 }}>{`// ${h.toUpperCase()}`}</Eyebrow>
      {children}
    </div>
  );
}

const SUBMITTED_TARGETS: readonly string[] = [
  'broker-staging.acme-bank.ru',
  'beta.broker-staging.acme-bank.ru',
  'github.com/acme/broker-portal',
];

const HI_AUTHS: readonly string[] = ['foothold', 'post-exploit', 'webshell', 'reverse-shell'];

export default function Approval(): ReactElement {
  const { t } = useTensol();
  const navigate = useNavigate();
  const role = 'security_lead';
  const isApprover = (role as string) === 'security_lead';

  const onApprove = (): void => {
    navigate('/live');
  };

  return (
    <AppShell
      breadcrumb={[t.navAssessments, t.apprTitle]}
      role="security_lead"
      density="comfortable"
    >
      <RouteHead title="Approval — Tensol" />
      <div data-screen-label="08 App — approval">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 32,
          }}
        >
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
            {t.apprTitle}
          </h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="dim" disabled={!isApprover}>
              {t.apprReject}
            </Btn>
            <Btn kind="secondary" disabled={!isApprover}>
              {t.apprSendBack}
            </Btn>
            <Btn kind="primary" disabled={!isApprover} onClick={onApprove}>
              {t.apprApprove} →
            </Btn>
          </div>
        </div>

        {!isApprover && (
          <div
            style={{
              marginBottom: 16,
              padding: '12px 14px',
              background: 'var(--bg-2)',
              border: '1px solid var(--line-soft)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Mono size={11} color="var(--red)">
              [deny] approve requires role security_lead. you are: {role}.
            </Mono>
            <Mono size={11} color="var(--fg-3)">
              read-only view enabled
            </Mono>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 320px',
            gap: 24,
            alignItems: 'flex-start',
          }}
        >
          <Card>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--ink)' }}>
              <Eyebrow>// SUBMITTED · a3 · broker-staging-baseline</Eyebrow>
              <h2
                style={{
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 500,
                  fontSize: 26,
                  letterSpacing: '-0.02em',
                  margin: '6px 0 0',
                }}
              >
                broker-portal-staging — Q2 baseline
              </h2>
              <Mono size={12} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>
                by M. Petrova · 2026-05-04 13:38 MSK · awaiting decision · 23m
              </Mono>
            </div>
            <div
              style={{
                padding: '20px 24px',
                display: 'flex',
                flexDirection: 'column',
                gap: 22,
              }}
            >
              <Section h="targets">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {SUBMITTED_TARGETS.map((x) => (
                    <Mono key={x} size={12}>
                      ■ {x}
                    </Mono>
                  ))}
                </div>
              </Section>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
                <Section h="scope">
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    allow: broker-staging.acme-bank.ru/*
                  </Mono>
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    deny: */admin/* */health */version
                  </Mono>
                </Section>
                <Section h="exclusions">
                  <Mono size={11.5} color="var(--fg-2)">
                    do not touch /payment/initiate (rate-limited critical path)
                  </Mono>
                </Section>
                <Section h="window">
                  <Mono size={11.5} color="var(--fg-2)">
                    2026-05-08 09:00 → 2026-05-10 18:00 MSK · 09:00–22:00 daily
                  </Mono>
                </Section>
                <Section h="profile">
                  <Mono size={11.5} color="var(--fg-2)">
                    PTES · deep · 6 parallel browsers
                  </Mono>
                </Section>
              </div>
              <Section h="declared high-impact authorizations">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {HI_AUTHS.map((c) => (
                    <StatusChip key={c} status={c} tone="danger" size="sm" />
                  ))}
                </div>
              </Section>
              <Section h="opplan summary">
                <Mono
                  size={11.5}
                  color="var(--fg-2)"
                  style={{ lineHeight: 1.55, display: 'block' }}
                >
                  phase 1 recon → 2h budget · phase 2 exploit (web + api) → 8h budget · phase 3
                  post-exploit on confirmed foothold only · 3 expected hitl gates
                  (credential-dump-sim, lateral-movement, persistence-test).
                </Mono>
              </Section>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
                <Section h="openapi documents">
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    broker-v1-openapi.json · 96 KB
                  </Mono>
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    partner-v1-openapi.json · 41 KB
                  </Mono>
                </Section>
                <Section h="credentials (no values)">
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    user_broker_low
                  </Mono>
                  <Mono size={11.5} color="var(--fg-2)" style={{ display: 'block' }}>
                    user_broker_admin
                  </Mono>
                </Section>
              </div>
            </div>
          </Card>

          <Card>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--ink)' }}>
              <Eyebrow>// approval log</Eyebrow>
            </div>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <Mono size={11} color="var(--fg-2)">
                2026-05-04 13:38 — submitted by M. Petrova
              </Mono>
              <Mono size={11} color="var(--fg-2)">
                2026-05-04 13:38 — assigned to A. Kovalev
              </Mono>
              <Mono size={11} color="var(--fg-3)">
                — pending decision —
              </Mono>
            </div>
            <div style={{ padding: '14px 16px', borderTop: '1px solid var(--ink)' }}>
              <Eyebrow style={{ marginBottom: 8 }}>// requires acknowledgement</Eyebrow>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Checkbox
                  checked
                  onChange={() => undefined}
                  label="targets are owned and authorized"
                />
                <Checkbox
                  checked
                  onChange={() => undefined}
                  label="declared high-impact categories are accepted"
                />
                <Checkbox
                  checked={false}
                  onChange={() => undefined}
                  label="legal sign-off filed for the engagement"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
