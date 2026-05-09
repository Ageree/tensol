// Tensol — C2 Projects (single-pane list). Ported 1:1 from
// tensol-platform-design-v2/source/blocks/06_ProjectsScreen.jsx ProjectsScreen.
import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Field, Input, Modal, Mono, Textarea } from '../components/primitives';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';

export default function Projects(): ReactElement {
  const { t } = useTensol();
  const navigate = useNavigate();
  const [openNew, setOpenNew] = useState(false);
  const role = 'security_lead';
  const isReadOnly = (role as string) === 'viewer' || (role as string) === 'auditor';

  const goTargets = (): void => {
    navigate('/targets');
  };

  return (
    <AppShell breadcrumb={[t.navProjects]} role="security_lead" density="comfortable">
      <RouteHead title="Projects — Tensol" />
      <div data-screen-label="05 App — projects">
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
            {t.projTitle}
          </h1>
          <Btn
            kind="primary"
            onClick={() => setOpenNew(true)}
            disabled={isReadOnly}
            title={isReadOnly ? 'requires operator+' : undefined}
          >
            {t.projNew} →
          </Btn>
        </div>

        <div>
          {TENSOL_DATA.projects.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={goTargets}
              style={{
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: '1.6fr 1fr 90px 130px',
                gap: 24,
                padding: '20px 4px',
                borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                background: 'transparent',
                border: 'none',
                alignItems: 'baseline',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: "'Space Grotesk', sans-serif",
                    fontWeight: 500,
                    fontSize: 18,
                    letterSpacing: '-0.01em',
                    color: 'var(--fg)',
                  }}
                >
                  {p.name}
                </div>
                <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>
                  {p.owner}
                </Mono>
              </div>
              <Mono size={12} color="var(--fg-2)">
                {p.targets} targets · {p.openAssessments} open
              </Mono>
              <Mono
                size={12}
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: p.confirmed > 0 ? 'var(--red)' : 'var(--fg-3)',
                }}
              >
                {p.confirmed > 0 ? `${p.confirmed} confirmed` : '—'}
              </Mono>
              <Mono size={11} color="var(--fg-3)" style={{ textAlign: 'right' }}>
                {p.last}
              </Mono>
            </button>
          ))}
        </div>

        <Modal open={openNew} onClose={() => setOpenNew(false)} title="// NEW PROJECT" width={520}>
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="name">
              <Input placeholder="payment-gateway-prod" />
            </Field>
            <Field label="owner">
              <Input value={TENSOL_DATA.user.name} disabled readOnly />
            </Field>
            <Field label="description" hint="short context, not target list">
              <Textarea rows={3} />
            </Field>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="dim" onClick={() => setOpenNew(false)}>
                cancel
              </Btn>
              <Btn kind="primary" onClick={() => setOpenNew(false)}>
                create →
              </Btn>
            </div>
          </div>
        </Modal>
      </div>
    </AppShell>
  );
}
