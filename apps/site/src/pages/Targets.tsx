// Tensol — C3 Targets (single-pane list). Ported 1:1 from
// tensol-platform-design-v2/source/blocks/06_ProjectsScreen.jsx TargetsScreen.
import { useState, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Field,
  Input,
  Modal,
  Mono,
  Select,
  StatusChip,
  Textarea,
  type SelectOption,
} from '../components/primitives';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';

type Tone = 'ok' | 'warn' | 'danger';
const ownTone = (s: string): Tone =>
  s === 'verified' ? 'ok' : s === 'pending' ? 'warn' : 'danger';

const TARGET_TYPES: ReadonlyArray<SelectOption> = [
  'web',
  'host',
  'network',
  'cloud',
  'api',
  'repository',
];

const VERIF_METHODS: ReadonlyArray<SelectOption> = [
  { value: 'dns', label: 'DNS TXT record' },
  { value: 'file', label: 'File on root' },
  { value: 'header', label: 'HTTP header' },
  { value: 'email', label: 'Email confirmation' },
  { value: 'cloud', label: 'Cloud-side proof' },
];

export default function Targets(): ReactElement {
  const { t } = useTensol();
  const [openReg, setOpenReg] = useState(false);
  const [regType, setRegType] = useState('web');
  const [regMethod, setRegMethod] = useState('dns');
  const role = 'security_lead';
  const isReadOnly = (role as string) === 'viewer' || (role as string) === 'auditor';

  return (
    <AppShell
      breadcrumb={[t.navProjects, t.navTargets]}
      role="security_lead"
      density="comfortable"
    >
      <RouteHead title="Targets — Tensol" />
      <div data-screen-label="06 App — targets">
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
            {t.tgtTitle}
          </h1>
          <Btn kind="primary" onClick={() => setOpenReg(true)} disabled={isReadOnly}>
            {t.tgtRegister} →
          </Btn>
        </div>

        <div>
          {TENSOL_DATA.targets.map((x, i) => (
            <div
              key={x.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.6fr 110px 1fr 100px',
                gap: 24,
                padding: '18px 4px',
                borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                alignItems: 'baseline',
              }}
            >
              <div>
                <Mono size={13.5} color="var(--fg)" style={{ wordBreak: 'break-all' }}>
                  {x.ident}
                </Mono>
                <Mono size={11} color="var(--fg-3)" style={{ display: 'block', marginTop: 4 }}>
                  {x.type} · via {x.method}
                </Mono>
              </div>
              <StatusChip status={x.ownership} tone={ownTone(x.ownership)} size="sm" />
              <Mono size={11} color="var(--fg-3)">
                {x.last}
              </Mono>
              <Mono
                size={12}
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: x.findings > 0 ? 'var(--red)' : 'var(--fg-3)',
                  textAlign: 'right',
                }}
              >
                {x.findings > 0 ? `${x.findings} findings` : '—'}
              </Mono>
            </div>
          ))}
        </div>

        <Modal
          open={openReg}
          onClose={() => setOpenReg(false)}
          title="// REGISTER TARGET"
          width={620}
        >
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label={t.tgtTypeLabel}>
                <Select value={regType} onChange={setRegType} options={TARGET_TYPES} />
              </Field>
              <Field label={t.tgtMethodLabel}>
                <Select value={regMethod} onChange={setRegMethod} options={VERIF_METHODS} />
              </Field>
            </div>
            <Field
              label={t.tgtIdentLabel}
              hint="hostname, IP, CIDR, repo URL, cloud folder"
            >
              <Input placeholder="app.acme-bank.ru" />
            </Field>
            <Field label={t.tgtDescLabel}>
              <Textarea rows={2} placeholder="customer-facing banking portal, prod" />
            </Field>
            <Field label={t.tgtContactLabel}>
              <Input placeholder="owner@acme-bank.ru" />
            </Field>
            <div
              style={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line-soft)',
                padding: '12px 14px',
              }}
            >
              <Mono size={11} color="var(--fg-3)" style={{ letterSpacing: '0.08em' }}>
                {`// VERIFICATION INSTRUCTIONS`}
              </Mono>
              <Mono
                size={11}
                color="var(--fg)"
                style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}
              >
                Add a TXT record:
                <br />
                _acme-tensol.app.acme-bank.ru. IN TXT "tensol-verify=8f2c…a1b9"
                <br />
                We re-check every 5 min for 24h. Until verified, target cannot enter scope.
              </Mono>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn kind="dim" onClick={() => setOpenReg(false)}>
                {t.cancel}
              </Btn>
              <Btn kind="primary" onClick={() => setOpenReg(false)}>
                {t.tgtCreate} →
              </Btn>
            </div>
          </div>
        </Modal>
      </div>
    </AppShell>
  );
}
