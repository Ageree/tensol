// Tensol — D1 Settings. Ported 1:1 from
// tensol-platform-design-v2/source/blocks/10_ReportsScreen.jsx SettingsScreen.
import { useState, type ReactElement, type ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { RouteHead } from '../components/RouteHead.tsx';
import {
  Btn,
  Card,
  Checkbox,
  Eyebrow,
  Field,
  Input,
  Mono,
  Segmented,
  Select,
  StatusChip,
  Tabs,
} from '../components/primitives';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';
import type { TensolLang } from '../i18n';

const SESSIONS = [
  { d: 'Mac · Chrome 134', ip: '78.41.22.18 · MSK', when: 'this session' },
  { d: 'iPhone · Safari', ip: '5.18.211.4 · MSK', when: '2h ago' },
] as const;

const TENANT_USERS = [
  { n: 'Alex Kovalev', e: 'alex.k@acme.com', r: 'security_lead', m: 'on', l: 'now' },
  { n: 'Maria Petrova', e: 'maria.p@acme.com', r: 'operator', m: 'on', l: '12m' },
  { n: 'Dmitry Smirnov', e: 'dmitry.s@acme.com', r: 'operator', m: 'on', l: '2h' },
  { n: 'Olga Ivanova', e: 'olga.i@acme.com', r: 'auditor', m: 'on', l: '1d' },
  { n: 'Pavel Lebedev', e: 'pavel.l@acme.com', r: 'developer', m: 'on', l: '3d' },
] as const;

const NOTIF_EVENTS = [
  { ev: 'HITL approval required', i: true, e: true },
  { ev: 'validator confirmed finding', i: true, e: true },
  { ev: 'assessment status changed', i: true, e: false },
  { ev: 'report ready', i: true, e: true },
  { ev: 'invite accepted', i: false, e: false },
] as const;

export default function Settings(): ReactElement {
  const { t, lang, setLang } = useTensol();
  const [tab, setTab] = useState(0);
  const role = 'security_lead';
  const isAdmin = (role as string) === 'security_lead' || (role as string) === 'tenant_admin';

  const renderProfile = (): ReactNode => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, maxWidth: 720 }}>
      <Field label={t.sProfileName}>
        <Input value={TENSOL_DATA.user.name} onChange={() => undefined} readOnly />
      </Field>
      <Field label={t.sProfileEmail}>
        <Input value={TENSOL_DATA.user.email} onChange={() => undefined} readOnly />
      </Field>
      <Field label={t.sProfileLang}>
        <Segmented<TensolLang>
          value={lang}
          onChange={setLang}
          options={[
            { value: 'en', label: 'EN' },
            { value: 'ru', label: 'RU' },
          ]}
        />
      </Field>
      <Field label={t.sProfileTz}>
        <Select value="MSK" onChange={() => undefined} options={['MSK', 'UTC', 'CET']} />
      </Field>

      <div
        style={{
          gridColumn: '1 / -1',
          borderTop: '1px solid var(--line-soft)',
          paddingTop: 18,
        }}
      >
        <Eyebrow style={{ marginBottom: 12 }}>// {t.sProfileMfa}</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusChip status="enabled · totp" tone="ok" />
          <Mono size={11} color="var(--fg-3)">
            enrolled 2026-03-12 · iPhone (iOS 18)
          </Mono>
          <Btn size="sm" kind="dim">
            Re-enroll
          </Btn>
        </div>
      </div>

      <div
        style={{
          gridColumn: '1 / -1',
          borderTop: '1px solid var(--line-soft)',
          paddingTop: 18,
        }}
      >
        <Eyebrow style={{ marginBottom: 10 }}>// {t.sProfileSessions}</Eyebrow>
        {SESSIONS.map((s, i) => (
          <div
            key={`${i}-${s.d}`}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '8px 0',
              borderBottom: '1px dashed var(--line-soft)',
            }}
          >
            <Mono size={11.5}>
              {s.d} · {s.ip}
            </Mono>
            <div style={{ display: 'flex', gap: 10 }}>
              <Mono size={11} color="var(--fg-3)">
                {s.when}
              </Mono>
              <Btn size="sm" kind="dim">
                Revoke
              </Btn>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          gridColumn: '1 / -1',
          borderTop: '1px solid var(--line-soft)',
          paddingTop: 18,
        }}
      >
        <Eyebrow style={{ marginBottom: 10 }}>// {t.sProfileTokens}</Eyebrow>
        <Mono
          size={11.5}
          color="var(--fg-2)"
          style={{ display: 'block', marginBottom: 8 }}
        >
          tnsl_pat_3a8f… · created 2026-04-02 · scope read:findings
        </Mono>
        <Btn size="sm" kind="secondary">
          + Issue token
        </Btn>
      </div>
    </div>
  );

  const renderTenant = (): ReactNode => {
    if (!isAdmin) {
      return (
        <div style={{ padding: 30, textAlign: 'center' }}>
          <Mono size={12} color="var(--red)">
            [deny] tenant settings require role tenant_admin or security_lead. you are: {role}.
          </Mono>
        </div>
      );
    }
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, maxWidth: 760 }}>
        <Field label={t.sTenantName}>
          <Input value="Acme Bank — Production" onChange={() => undefined} readOnly />
        </Field>
        <Field label={t.sTenantSlug}>
          <Input value="acme-prod" onChange={() => undefined} readOnly />
        </Field>
        <Field label={t.sTenantRegion}>
          <Select
            value="ru-yandex"
            onChange={() => undefined}
            options={[
              { value: 'ru-yandex', label: 'ru · Yandex Cloud · ru-central1' },
              { value: 'eu-fra', label: 'eu · fra1' },
            ]}
          />
        </Field>
        <Field label={t.sTenantRetention}>
          <Select
            value="365d"
            onChange={() => undefined}
            options={['90d', '180d', '365d', '730d']}
          />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <Eyebrow style={{ marginBottom: 10 }}>// {t.sTenantUsers}</Eyebrow>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              border: '1px solid var(--fg)',
            }}
          >
            <thead>
              <tr style={{ background: 'var(--fg)', color: 'var(--bg)' }}>
                {['name', 'email', 'role', 'mfa', 'last seen', ''].map((h, i) => (
                  <th
                    key={`${i}-${h}`}
                    style={{
                      textAlign: 'left',
                      padding: '8px 12px',
                      fontFamily: 'monospace',
                      fontSize: 10,
                      fontWeight: 500,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TENANT_USERS.map((u, i) => (
                <tr key={`${i}-${u.e}`} style={{ borderTop: '1px solid var(--line-soft)' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <Mono size={12}>{u.n}</Mono>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <Mono size={11} color="var(--fg-2)">
                      {u.e}
                    </Mono>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <StatusChip status={u.r} tone="muted" size="sm" />
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <Mono size={11} color="var(--fg-2)">
                      {u.m}
                    </Mono>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <Mono size={11} color="var(--fg-3)">
                      {u.l}
                    </Mono>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    <Btn size="sm" kind="dim">
                      Manage
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" kind="secondary">
              + Invite user
            </Btn>
          </div>
        </div>
        <Field label={t.sTenantPwPolicy}>
          <Select
            value="strict"
            onChange={() => undefined}
            options={['standard', 'strict', 'custom']}
          />
        </Field>
        <Field label={t.sTenantMfaPolicy}>
          <Select
            value="enforced"
            onChange={() => undefined}
            options={['optional', 'recommended', 'enforced']}
          />
        </Field>
      </div>
    );
  };

  const renderNotifications = (): ReactNode => (
    <div style={{ maxWidth: 720 }}>
      <Eyebrow style={{ marginBottom: 10 }}>// channels</Eyebrow>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          border: '1px solid var(--fg)',
        }}
      >
        <thead>
          <tr style={{ background: 'var(--fg)', color: 'var(--bg)' }}>
            {['event', 'in-app', 'email'].map((h, i) => (
              <th
                key={`${i}-${h}`}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  fontFamily: 'monospace',
                  fontSize: 10,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {NOTIF_EVENTS.map((n, i) => (
            <tr key={`${i}-${n.ev}`} style={{ borderTop: '1px solid var(--line-soft)' }}>
              <td style={{ padding: '10px 12px' }}>
                <Mono size={12}>{n.ev}</Mono>
              </td>
              <td style={{ padding: '10px 12px' }}>
                <Checkbox checked={n.i} onChange={() => undefined} label="" />
              </td>
              <td style={{ padding: '10px 12px' }}>
                <Checkbox checked={n.e} onChange={() => undefined} label="" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <AppShell breadcrumb={[t.navSettings]} role="security_lead" density="comfortable">
      <RouteHead title="Settings — Tensol" />
      <div data-screen-label="12 App — settings">
        <div style={{ marginBottom: 32 }}>
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
            {t.sTitle}
          </h1>
        </div>
        <Card>
          <Tabs
            value={tab}
            onChange={setTab}
            options={t.sTabs.map((label, i) => ({ value: i, label }))}
          />
          <div style={{ padding: '24px 28px' }}>
            {tab === 0 && renderProfile()}
            {tab === 1 && renderTenant()}
            {tab === 2 && renderNotifications()}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
