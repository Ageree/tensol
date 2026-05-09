// Tensol — C1 Dashboard. Operations overview for security_lead/operator.
// Ported 1:1 from tensol-platform-design-v2/source/blocks/05_KpiCell.jsx Dashboard().
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import { Btn, Mono, SeverityChip } from '../components/primitives';
import { useTensol } from '../context';
import {
  TENSOL_DATA,
  type Approval,
  type Assessment,
  type Finding,
  type Project,
} from '../data';

interface AssessmentRowProps {
  readonly a: Assessment;
}

const AssessmentRow = ({ a }: AssessmentRowProps): ReactElement => {
  const proj: Project | undefined = TENSOL_DATA.projects.find((p) => p.id === a.project);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 90px 80px',
        gap: 16,
        alignItems: 'center',
        padding: '14px 4px',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <div>
        <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: 'var(--fg)' }}>{a.name}</div>
        <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4, display: 'block' }}>
          {proj ? proj.name : a.project}
        </Mono>
      </div>
      <Mono
        size={11}
        color={a.status === 'running' ? 'var(--red)' : 'var(--fg-3)'}
        style={{ letterSpacing: '0.04em', textTransform: 'uppercase' }}
      >
        {a.phase}
      </Mono>
      <Mono
        size={11}
        color="var(--fg-2)"
        style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
      >
        {a.findings.confirmed}c · {a.findings.candidate}?
      </Mono>
    </div>
  );
};

interface FindingRowProps {
  readonly f: Finding;
  readonly onOpen: () => void;
}

const FindingRow = ({ f, onOpen }: FindingRowProps): ReactElement => {
  const time = f.foundAt.includes(' ') ? f.foundAt.split(' ')[1] ?? f.foundAt : f.foundAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: '12px 16px',
        borderBottom: '1px solid var(--line-soft)',
        display: 'grid',
        gridTemplateColumns: '90px 1fr 80px 110px',
        gap: 12,
        alignItems: 'center',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-2)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <SeverityChip sev={f.sev} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: 13.5,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {f.title}
        </div>
        <Mono size={11} color="var(--fg-3)">
          {f.asset}
        </Mono>
      </div>
      <Mono size={11} color="var(--fg-2)">
        {f.conf}
      </Mono>
      <Mono size={11} color="var(--fg-3)" style={{ textAlign: 'right' }}>
        {time}
      </Mono>
    </button>
  );
};

interface ApprovalRowProps {
  readonly a: Approval;
  readonly onAct: () => void;
}

const ApprovalRow = ({ a, onAct }: ApprovalRowProps): ReactElement => (
  <div
    style={{
      padding: '14px 4px',
      borderBottom: '1px solid var(--line-soft)',
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 16,
      alignItems: 'center',
    }}
  >
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 14,
          color: 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {a.detail}
      </div>
      <Mono size={10.5} color="var(--fg-3)" style={{ marginTop: 4, display: 'block' }}>
        {a.target} · {a.requestedBy} · {a.when}
      </Mono>
    </div>
    <Btn kind="dim" size="sm" onClick={onAct}>
      Review →
    </Btn>
  </div>
);

const Dashboard = (): ReactElement => {
  const { t } = useTensol();
  const navigate = useNavigate();

  const active: readonly Assessment[] = TENSOL_DATA.assessments.filter((a) => a.status === 'running');
  const recent: readonly Finding[] = TENSOL_DATA.findings
    .filter((f) => f.status === 'confirmed')
    .slice(0, 5);
  const approvals: readonly Approval[] = TENSOL_DATA.approvals;

  const goBuilder = (): void => {
    navigate('/builder');
  };
  const goLive = (): void => {
    navigate('/live');
  };
  const goFindings = (): void => {
    navigate('/findings');
  };
  const goApproval = (): void => {
    navigate('/approval');
  };

  return (
    <AppShell breadcrumb={[t.navDashboard]} role="security_lead" density="comfortable">
      <RouteHead title="Dashboard — Tensol" />
      <div data-screen-label="04 App — dashboard">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            marginBottom: 32,
            flexWrap: 'wrap',
            gap: 16,
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
            {t.dashTitle}
          </h1>
          <Btn kind="primary" onClick={goBuilder}>
            {t.dashCreate} →
          </Btn>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 48 }}>
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
                active assessments
              </Mono>
              <button
                type="button"
                onClick={goLive}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: 'var(--fg-3)',
                  letterSpacing: '0.04em',
                  padding: 0,
                }}
              >
                view all →
              </button>
            </div>
            {active.length > 0 ? (
              active.map((a) => <AssessmentRow key={a.id} a={a} />)
            ) : (
              <div style={{ padding: '32px 0', color: 'var(--fg-3)' }}>
                <Mono size={12}>{t.dashEmpty}</Mono>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                margin: '40px 0 12px',
                paddingBottom: 8,
                borderBottom: '1px solid var(--fg)',
              }}
            >
              <Mono
                size={11}
                color="var(--fg)"
                style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}
              >
                recent confirmed findings
              </Mono>
              <button
                type="button"
                onClick={goFindings}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: 'var(--fg-3)',
                  letterSpacing: '0.04em',
                  padding: 0,
                }}
              >
                view all →
              </button>
            </div>
            {recent.map((f) => (
              <FindingRow key={f.id} f={f} onOpen={goFindings} />
            ))}
          </section>

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
                pending hitl approvals
              </Mono>
              <Mono size={11} color="var(--red)">
                {approvals.length}
              </Mono>
            </div>
            {approvals.map((a) => (
              <ApprovalRow key={a.id} a={a} onAct={goApproval} />
            ))}
          </section>
        </div>
      </div>
    </AppShell>
  );
};

export default Dashboard;
