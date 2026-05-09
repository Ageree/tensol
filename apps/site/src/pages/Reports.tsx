// Tensol — C9 Reports. Ported 1:1 from
// tensol-platform-design-v2/source/blocks/10_ReportsScreen.jsx ReportsScreen.
import { useState, type ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Checkbox,
  Eyebrow,
  Field,
  Modal,
  Mono,
  ProgressBar,
  Select,
  StatusChip,
} from '../components/primitives';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';

const TYPE_LABEL: Record<string, string> = {
  tech: 'technical',
  exec: 'executive',
  comp: 'compliance',
};

export default function Reports(): ReactElement {
  const { t } = useTensol();
  const role = 'security_lead';
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);

  const startGen = (): void => {
    setGenerating(true);
    setProgress(0);
    const id = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          window.clearInterval(id);
          window.setTimeout(() => {
            setGenerating(false);
            setGenOpen(false);
          }, 400);
          return 100;
        }
        return p + 8;
      });
    }, 240);
  };

  const closeModal = (): void => {
    if (generating) return;
    setGenOpen(false);
  };

  return (
    <AppShell breadcrumb={[t.navReports]} role="security_lead" density="comfortable">
      <RouteHead title="Reports — Tensol" />
      <div data-screen-label="11 App — reports">
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
            {t.rTitle}
          </h1>
          <Btn
            kind="primary"
            disabled={(role as string) === 'viewer'}
            onClick={() => setGenOpen(true)}
          >
            + {t.rGenerate}
          </Btn>
        </div>

        <table
          style={{ width: '100%', borderCollapse: 'collapse', background: 'transparent' }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line-soft)' }}>
              {[t.rColProject, t.rColType, t.rColDate, t.rColStatus, ''].map((h, i) => (
                <th
                  key={`${i}-${h}`}
                  style={{
                    textAlign: 'left',
                    padding: '10px 4px',
                    fontFamily: 'monospace',
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 500,
                    color: 'var(--fg-3)',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TENSOL_DATA.reports.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <td style={{ padding: '16px 4px' }}>
                  <Mono size={13}>{r.project}</Mono>
                  <Mono
                    size={10.5}
                    color="var(--fg-3)"
                    style={{ display: 'block', marginTop: 4 }}
                  >
                    {r.assessment}
                  </Mono>
                </td>
                <td style={{ padding: '16px 4px' }}>
                  <Mono size={11.5} color="var(--fg-2)">
                    {TYPE_LABEL[r.type] ?? r.type}
                  </Mono>
                </td>
                <td style={{ padding: '16px 4px' }}>
                  <Mono size={11} color="var(--fg-3)">
                    {r.date}
                  </Mono>
                </td>
                <td style={{ padding: '16px 4px' }}>
                  <StatusChip status={r.status} tone="muted" size="sm" />
                </td>
                <td style={{ padding: '16px 4px', textAlign: 'right' }}>
                  <Btn size="sm" kind="dim">
                    PDF
                  </Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <Modal
          open={genOpen}
          onClose={closeModal}
          title={`// ${t.rGenTitle}`}
          width={600}
        >
          <div
            style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            {!generating && (
              <>
                <Field label={t.rGenAss}>
                  <Select
                    value="a1"
                    onChange={() => undefined}
                    options={TENSOL_DATA.assessments.map((a) => ({ value: a.id, label: a.name }))}
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label={t.rGenType}>
                    <Select
                      value="tech"
                      onChange={() => undefined}
                      options={[
                        { value: 'exec', label: 'executive summary' },
                        { value: 'tech', label: 'technical pentest' },
                        { value: 'comp', label: 'compliance mapping' },
                      ]}
                    />
                  </Field>
                  <Field label={t.rGenLang}>
                    <Select
                      value="en"
                      onChange={() => undefined}
                      options={[
                        { value: 'en', label: 'english' },
                        { value: 'ru', label: 'русский' },
                      ]}
                    />
                  </Field>
                </div>
                <Field label={t.rGenTemplate}>
                  <Select
                    value="default"
                    onChange={() => undefined}
                    options={[
                      { value: 'default', label: 'default' },
                      { value: 'gost', label: 'GOST R · FSTEC mapping appendix' },
                      { value: 'pcidss', label: 'PCI DSS appendix' },
                    ]}
                  />
                </Field>
                <Checkbox
                  checked
                  onChange={() => undefined}
                  label={t.rGenRedact}
                  hint="masks credentials, tokens, pii in command output and HTTP capture"
                />
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'flex-end',
                    marginTop: 8,
                  }}
                >
                  <Btn kind="dim" onClick={() => setGenOpen(false)}>
                    {t.cancel}
                  </Btn>
                  <Btn kind="primary" onClick={startGen}>
                    {t.rGenCta} →
                  </Btn>
                </div>
              </>
            )}
            {generating && (
              <>
                <Eyebrow>// generating · do not close</Eyebrow>
                <ProgressBar
                  value={progress}
                  segments={48}
                  height={10}
                  color="var(--red)"
                  label={`assembling evidence · ${progress}%`}
                />
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: 'var(--ink)',
                    color: 'var(--paper)',
                    fontFamily: 'monospace',
                    fontSize: 11,
                    lineHeight: 1.6,
                  }}
                >
{`[ok]   collect engagement metadata
[ok]   bundle 11 findings
[ok]   resolve 11 evidence packages (sha256 verified)
[${progress > 50 ? 'ok' : 'wait'}]  render attack-graph snapshot
[${progress > 75 ? 'ok' : 'wait'}]  framework mappings · 4 sets
[${progress > 90 ? 'ok' : 'wait'}]  immutable snapshot · sign · seal`}
                </pre>
              </>
            )}
          </div>
        </Modal>
      </div>
    </AppShell>
  );
}
