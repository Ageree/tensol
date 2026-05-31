// Sthrip — App shell: sticky left nav, breadcrumb topbar, content slot.
import { Fragment, type CSSProperties, type ReactElement, type ReactNode, useState } from 'react';
import {
  Activity,
  Code2,
  FileText,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  ShieldCheck,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTensol } from '../context';
import { TENSOL_DATA } from '../data';
import { TENSOL_I18N, type TensolLang } from '../i18n';
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
  brand?: 'tensol' | 'sthrip';
  language?: TensolLang;
  showLanguageSwitcher?: boolean;
  surface?: 'default' | 'white-mono';
}

const ROUTE_PATHS: Record<AppRoute, string> = {
  dashboard: '/dashboard',
  live: '/live',
  findings: '/findings',
  reports: '/reports',
  reviews: '/reviews',
  settings: '/settings',
};

const SIDEBAR_COLLAPSED_KEY = 'sthrip.sidebar.collapsed';

function getInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function pathToRoute(pathname: string): AppRoute | null {
  const seg = pathname.split('/').filter(Boolean)[0];
  if (!seg) return null;
  const candidate = seg as AppRoute;
  if (candidate in ROUTE_PATHS) return candidate;
  return null;
}

interface NavItemProps {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
  collapsed?: boolean;
}

function NavItem({ icon, label, active, badge, onClick, disabled, collapsed = false }: NavItemProps): ReactElement {
  const [hov, setHov] = useState(false);
  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: collapsed ? 'center' : 'flex-start',
    gap: collapsed ? 0 : 10,
    minHeight: 38,
    padding: collapsed ? '8px 0' : '8px 12px',
    background: active ? 'var(--fg)' : hov ? 'var(--bg-alt)' : 'transparent',
    color: active ? 'var(--bg)' : disabled ? 'var(--fg-3)' : 'var(--fg)',
    border: 'none',
    borderLeft: collapsed ? 'none' : `2px solid ${active ? 'var(--red)' : 'transparent'}`,
    borderRadius: 8,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    textAlign: 'left',
    width: collapsed ? 'calc(100% - 16px)' : 'calc(100% - 24px)',
    margin: collapsed ? '0 8px 4px' : '0 12px 4px',
    position: 'relative',
    transition: 'background 140ms ease, color 140ms ease',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={collapsed ? label : undefined}
      style={style}
    >
      <span
        style={{
          width: collapsed ? 22 : 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: active ? 1 : 0.82,
        }}
      >
        {icon}
      </span>
      {!collapsed && <span style={{ flex: 1 }}>{label}</span>}
      {badge != null && !collapsed && (
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
      {badge != null && collapsed && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 5,
            right: 12,
            width: 5,
            height: 5,
            background: active ? 'var(--bg)' : 'var(--fg)',
          }}
        />
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
  brand = 'tensol',
  language,
  showLanguageSwitcher = true,
  surface = 'default',
}: AppShellProps): ReactElement {
  const { t: contextT } = useTensol();
  const t = language ? TENSOL_I18N[language] : contextT;
  const navigate = useNavigate();
  const location = useLocation();
  const route = pathToRoute(location.pathname);
  const isReadOnly = role === 'viewer' || role === 'auditor';
  const assessmentsActive = route === 'live';
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getInitialSidebarCollapsed);

  const go = (r: AppRoute): void => {
    navigate(ROUTE_PATHS[r]);
  };

  const toggleSidebarCollapsed = (): void => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // Ignore storage failures; the in-memory UI state still updates.
      }
      return next;
    });
  };

  const crumbs = breadcrumb ?? [];
  const lastCrumbIdx = crumbs.length - 1;
  const isWhiteMono = surface === 'white-mono';
  const shouldShowTopbar = !isWhiteMono || actions != null || showLanguageSwitcher;
  const shouldShowSidebarLabels = !isWhiteMono && !sidebarCollapsed;
  const navIconProps = { size: 17, strokeWidth: 1.8 };

  return (
    <div
      data-screen-label={`shell-${route ?? 'unknown'}`}
      style={{
        ...(isWhiteMono
          ? ({
              '--paper': '#fbf4e2',
              '--bg': '#fbf4e2',
              '--bg-alt': '#f3ead2',
              '--fg-inv': '#fbf4e2',
              '--line-soft': 'rgba(18, 12, 13, 0.22)',
              '--red': '#120c0d',
              '--red-deep': '#120c0d',
              '--red-tint': 'rgba(18, 12, 13, 0.08)',
            } as CSSProperties)
          : {}),
        minHeight: '100vh',
        background: 'var(--paper)',
        color: 'var(--ink)',
        display: 'grid',
        gridTemplateColumns: sidebarCollapsed ? '72px 1fr' : '232px 1fr',
        transition: 'grid-template-columns 180ms ease',
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
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            minHeight: 76,
            padding: sidebarCollapsed ? '18px 0 14px' : '20px 16px',
            borderBottom: isWhiteMono ? 'none' : '1px solid var(--fg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            gap: 10,
          }}
        >
          {!sidebarCollapsed && brand === 'sthrip' ? (
            <button
              type="button"
              aria-label="STHRIP home"
              onClick={() => navigate('/')}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <img
                src="/assets/tensol-logo-mark-white.png"
                alt=""
                aria-hidden="true"
                style={{
                  display: 'block',
                  width: 30,
                  height: 30,
                  filter: 'invert(1) brightness(0.12)',
                }}
              />
              <img
                src="/assets/sthrip-wordmark-white.png"
                alt="STHRIP"
                style={{
                  display: 'block',
                  width: 112,
                  height: 'auto',
                  filter: 'invert(1) brightness(0.12)',
                }}
              />
            </button>
          ) : !sidebarCollapsed ? (
            <LogoLockup size={16} color="var(--fg)" onClick={() => navigate('/')} />
          ) : null}
          <button
            type="button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleSidebarCollapsed}
            style={{
              width: sidebarCollapsed ? 38 : 32,
              height: sidebarCollapsed ? 38 : 32,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'transparent',
              color: 'var(--fg)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={18} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>
          {sidebarCollapsed && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: isWhiteMono ? 0 : 1,
                background: 'var(--fg)',
              }}
            />
          )}
        </div>

        <div style={{ padding: '12px 0 0' }}>
          {shouldShowSidebarLabels && <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navProduct}</Eyebrow>}
          <NavItem
            icon={<Gauge {...navIconProps} />}
            label={t.navDashboard}
            active={route === 'dashboard'}
            onClick={() => go('dashboard')}
            collapsed={sidebarCollapsed}
          />
          <NavItem
            icon={<Activity {...navIconProps} />}
            label={t.navAssessments}
            active={assessmentsActive}
            onClick={() => go('live')}
            badge="2"
            collapsed={sidebarCollapsed}
          />
          <NavItem
            icon={<ShieldCheck {...navIconProps} />}
            label={t.navFindings}
            active={route === 'findings'}
            onClick={() => go('findings')}
            badge="11"
            collapsed={sidebarCollapsed}
          />
          <NavItem
            icon={<FileText {...navIconProps} />}
            label={t.navReports}
            active={route === 'reports'}
            onClick={() => go('reports')}
            collapsed={sidebarCollapsed}
          />
          <NavItem
            icon={<Code2 {...navIconProps} />}
            label="Reviews"
            active={route === 'reviews'}
            onClick={() => go('reviews')}
            collapsed={sidebarCollapsed}
          />
        </div>

        <div style={{ padding: '24px 0 0' }}>
          {shouldShowSidebarLabels && <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navAccount}</Eyebrow>}
          <NavItem
            icon={<SettingsIcon {...navIconProps} />}
            label={t.navSettings}
            active={route === 'settings'}
            onClick={() => go('settings')}
            collapsed={sidebarCollapsed}
          />
        </div>

        {!isWhiteMono && (
          <div
            style={{
              marginTop: 'auto',
              padding: sidebarCollapsed ? '16px 0' : '16px',
              borderTop: '1px solid var(--fg)',
              display: sidebarCollapsed ? 'flex' : 'block',
              justifyContent: 'center',
            }}
          >
            {sidebarCollapsed ? (
              <span
                title={t.engineHealth}
                style={{
                  width: 8,
                  height: 8,
                  background: '#1F7A3A',
                  display: 'block',
                }}
              />
            ) : (
              <>
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
              </>
            )}
          </div>
        )}
      </aside>

      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {shouldShowTopbar && (
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
              {showLanguageSwitcher && <LangSwitcher />}
              {actions}
            </div>
          </header>
        )}

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
