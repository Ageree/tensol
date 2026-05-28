// Tensol — App shell: sticky left nav, breadcrumb topbar, content slot.
// Used by all C* and D1 screens.

const { useState: useStateShell } = React;

function NavItem({ icon, label, active, badge, onClick, disabled }) {
  const [hov, setHov] = useStateShell(false);
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px',
        background: active ? 'var(--fg)' : (hov ? 'var(--bg-2)' : 'transparent'),
        color: active ? 'var(--bg)' : (disabled ? 'var(--fg-3)' : 'var(--fg)'),
        border: 'none', borderLeft: `2px solid ${active ? 'var(--red)' : 'transparent'}`,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        textAlign: 'left', width: '100%',
        position: 'relative',
      }}>
      <span style={{ width: 14, opacity: 0.7, fontFamily: 'monospace' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge != null && (
        <span style={{
          fontSize: 10, padding: '1px 5px',
          background: active ? 'var(--bg)' : 'var(--red)',
          color: active ? 'var(--fg)' : 'var(--paper)',
          letterSpacing: 0, lineHeight: 1.4,
        }}>{badge}</span>
      )}
    </button>
  );
}

function AppShell({ route, onRoute, breadcrumb, actions, children, role, density = 'comfortable' }) {
  const { t } = useTensol();
  const isReadOnly = role === 'viewer' || role === 'auditor';
  return (
    <div data-screen-label={`shell-${route}`} style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      display: 'grid', gridTemplateColumns: '232px 1fr',
    }}>
      {/* LEFT NAV */}
      <aside style={{
        background: 'var(--bg)', borderRight: '1px solid var(--fg)',
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
      }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid var(--fg)' }}>
          <a href="#home" onClick={e => { e.preventDefault(); onRoute('marketing'); }} style={{ textDecoration: 'none', color: 'var(--fg)' }}>
            <LogoLockup size={16} color="var(--fg)" />
          </a>
        </div>

        <div style={{ padding: '12px 0 0' }}>
          <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navProduct}</Eyebrow>
          <NavItem icon="▸" label={t.navDashboard}  active={route === 'dashboard'}  onClick={() => onRoute('dashboard')} />
          <NavItem icon="▸" label={t.navProjects}   active={route === 'projects'}   onClick={() => onRoute('projects')} />
          <NavItem icon="▸" label={t.navTargets}    active={route === 'targets'}    onClick={() => onRoute('targets')} />
          <NavItem icon="▸" label={t.navAssessments} active={route === 'live' || route === 'builder' || route === 'approval'} onClick={() => onRoute('live')} badge="2" />
          <NavItem icon="▸" label={t.navFindings}   active={route === 'findings'}   onClick={() => onRoute('findings')} badge="11" />
          <NavItem icon="▸" label={t.navReports}    active={route === 'reports'}    onClick={() => onRoute('reports')} />
        </div>

        <div style={{ padding: '24px 0 0' }}>
          <Eyebrow style={{ padding: '0 16px 8px', fontSize: 10 }}>{t.navAccount}</Eyebrow>
          <NavItem icon="▸" label={t.navSettings}   active={route === 'settings'}   onClick={() => onRoute('settings')} />
        </div>

        {/* engine status pinned bottom */}
        <div style={{ marginTop: 'auto', padding: '16px', borderTop: '1px solid var(--fg)' }}>
          <Eyebrow style={{ marginBottom: 8 }}>{t.engineHealth}</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, background: '#1F7A3A' }} />
            <Mono size={12} color="var(--fg)">ok · 14ms p50</Mono>
          </div>
          <div style={{ marginTop: 12 }}>
            <Mono size={11} color="var(--fg)">{TENSOL_DATA.user.name}</Mono>
            <Mono size={10} color="var(--fg-3)" style={{ display: 'block' }}>{role}</Mono>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* breadcrumb topbar */}
        <header style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'var(--paper)',
          borderBottom: '1px solid var(--fg)',
          padding: density === 'compact' ? '10px 24px' : '14px 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12, letterSpacing: '0.04em', color: 'var(--fg-2)',
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden',
          }}>
            <span>{TENSOL_DATA.user.tenant}</span>
            {(breadcrumb || []).map((b, i) => (
              <React.Fragment key={i}>
                <span>▸</span>
                <span style={{ color: i === breadcrumb.length - 1 ? 'var(--fg)' : 'var(--fg-2)' }}>{b}</span>
              </React.Fragment>
            ))}
            {isReadOnly && (
              <span style={{ marginLeft: 12 }}>
                <StatusChip status={`read-only · ${role}`} tone="warn" size="sm" />
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {actions}
          </div>
        </header>

        <div style={{ padding: density === 'compact' ? '20px 24px' : '32px 28px', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

window.AppShell = AppShell;

