// Tensol — App shell: sticky left nav, breadcrumb topbar, content slot.
import { Fragment, type CSSProperties, type ReactElement, type ReactNode, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';
import { LangSwitcher } from './LangSwitcher.tsx';
import { Eyebrow, LogoLockup, Mono, StatusChip } from './primitives';

export type AppRoute =
  | 'dashboard'
  | 'live'
  | 'findings'
  | 'reports'
  | 'reviews'
  | 'settings';

export type AppRole =
  | 'security_lead'
  | 'operator'
  | 'viewer'
  | 'auditor'
  | 'tenant_admin'
  | 'platform_admin'
  | 'developer';

export interface AppShellProps {
  breadcrumb?: string[];
  actions?: ReactNode;
  children: ReactNode;
  role?: AppRole;
  density?: 'comfortable' | 'compact';
}

const ROUTE_PATHS: Record<AppRoute, string> = {
  dashboard: '/dashboard',
  live: '/live',
  findings: '/findings',
  reports: '/reports',
  reviews: '/reviews',
  settings: '/settings',
};

function pathToRoute(pathname: string): AppRoute | null {
  const seg = pathname.split('/').filter(Boolean)[0];
  if (!seg) return null;
  const candidate = seg as AppRoute;
  if (candidate in ROUTE_PATHS) return candidate;
  return null;
}

interface NavItemProps {
  icon: string;
  label: string;
  active: boolean;
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
}

function NavItem({ icon, label, active, badge, onClick, disabled }: NavItemProps): ReactElement {
  const [hov, setHov] = useState(false);
  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    background: active ? 'var(--fg)' : hov ? 'var(--bg-2)' : 'transparent',
    color: active ? 'var(--bg)' : disabled ? 'var(--fg-3)' : 'var(--fg)',
    border: 'none',
    borderLeft: `2px solid ${active ? 'var(--red)' : 'transparent'}`,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    textAlign: 'left',
    width: '100%',
    position: 'relative',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={style}
    >
      <span style={{ width: 14, opacity: 0.7, fontFamily: 'monospace' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && (
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            background: active ? 'var(--bg)' : 'var(--red)',
            color: active ? 'var(--fg)' : 'var(--paper)',
            letterSpacing: 0,
            lineHeight: 1.4,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export function AppShell({
  breadcrumb,
  actions,
  children,
  role,
  density = 'comfortable',
}: AppShellProps): ReactElement {
  const { t } = useTensol();
  const navigate = useNavigate();
  const location = useLocation();
  const route = pathToRoute(location.pathname);
  const isReadOnly = role === 'viewer' || role === 'auditor';
  const assessmentsActive = route === 'live';

  const go = (r: AppRoute): void => {
    navigate(ROUTE_PATHS[r]);
  };

  const crumbs = breadcrumb ?? [];
  const lastCrumbIdx = crumbs.length - 1;

  return (
    <div
      data-screen-label={`shell-${route ?? 'unknown'}`}
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        color: 'var(--ink)',
        display: 'grid',
        gridTemplateColumns: '232px 1fr',
      }}
    >
      <aside
        style={{
          background: 'var(--bg)',
          borderRight: '1px solid var(--fg)',
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div style={{ padding: '20px 16px', borderBottom: '1px solid var(--fg)' }}>
          <LogoLockup size={16} color="var(--fg)" onClick={() => navigate('/')} />
        </div>

        <div style={{ padding: '12px 0 0' }}>
          <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navProduct}</Eyebrow>
          <NavItem icon="▸" label={t.navDashboard} active={route === 'dashboard'} onClick={() => go('dashboard')} />
          <NavItem
            icon="▸"
            label={t.navAssessments}
            active={assessmentsActive}
            onClick={() => go('live')}
            badge="2"
          />
          <NavItem
            icon="▸"
            label={t.navFindings}
            active={route === 'findings'}
            onClick={() => go('findings')}
            badge="11"
          />
          <NavItem icon="▸" label={t.navReports} active={route === 'reports'} onClick={() => go('reports')} />
          <NavItem icon="▸" label="Reviews" active={route === 'reviews'} onClick={() => go('reviews')} />
        </div>

        <div style={{ padding: '24px 0 0' }}>
          <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navAccount}</Eyebrow>
          <NavItem icon="▸" label={t.navSettings} active={route === 'settings'} onClick={() => go('settings')} />
        </div>

        <div style={{ marginTop: 'auto', padding: '16px', borderTop: '1px solid var(--fg)' }}>
          <Eyebrow style={{ marginBottom: 8 }}>{t.engineHealth}</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, background: '#1F7A3A' }} />
            <Mono size={12} color="var(--fg)">
              ok · 14ms p50
            </Mono>
          </div>
          <div style={{ marginTop: 12 }}>
            <Mono size={11} color="var(--fg)">
              {TENSOL_DATA.user.name}
            </Mono>
            <Mono size={10} color="var(--fg-3)" style={{ display: 'block' }}>
              {role ?? TENSOL_DATA.user.role}
            </Mono>
          </div>
        </div>
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 50,
            background: 'var(--paper)',
            borderBottom: '1px solid var(--fg)',
            padding: density === 'compact' ? '10px 24px' : '14px 28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              letterSpacing: '0.04em',
              color: 'var(--fg-2)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <span>{TENSOL_DATA.user.tenant}</span>
            {crumbs.map((b, i) => (
              <Fragment key={`${i}-${b}`}>
                <span>▸</span>
                <span style={{ color: i === lastCrumbIdx ? 'var(--fg)' : 'var(--fg-2)' }}>{b}</span>
              </Fragment>
            ))}
            {isReadOnly && role && (
              <span style={{ marginLeft: 12 }}>
                <StatusChip status={`read-only · ${role}`} tone="warn" size="sm" />
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <LangSwitcher />
            {actions}
          </div>
        </header>

        <main
          style={{
            padding: density === 'compact' ? '20px 24px' : '32px 28px',
            flex: 1,
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
