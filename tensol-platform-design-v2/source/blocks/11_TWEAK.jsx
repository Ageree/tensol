const useStateApp = React.useState;
const useEffectApp = React.useEffect;
const useMemoApp = React.useMemo;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "lang": "en",
  "theme": "light",
  "density": "comfortable",
  "monoRatio": 0.3,
  "redUsage": "reserved",
  "role": "security_lead"
}/*EDITMODE-END*/;

function TensolApp() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useStateApp('marketing');
  const lang = tw.lang === 'ru' ? 'ru' : 'en';
  const t = TENSOL_I18N[lang];
  const ctx = useMemoApp(() => ({ t, lang, setLang: (l) => setTweak('lang', l) }), [t, lang]);

  // sync <html lang>
  useEffectApp(() => { document.documentElement.lang = lang; }, [lang]);

  const isApp = route !== 'marketing' && route !== 'login' && route !== 'bootstrap' && route !== 'invite';

  const screen = (() => {
    switch (route) {
      case 'marketing':
        return <MarketingPage onSignIn={() => setRoute('login')} onDemo={() => setRoute('login')} monoRatio={tw.monoRatio} redUsage={tw.redUsage} />;
      case 'login':
        return <LoginScreen onSubmit={() => setRoute('dashboard')} onBack={() => setRoute('marketing')} />;
      case 'bootstrap':
        return <BootstrapScreen onSubmit={() => setRoute('dashboard')} onBack={() => setRoute('marketing')} />;
      case 'invite':
        return <InviteScreen onSubmit={() => setRoute('dashboard')} onBack={() => setRoute('login')} />;
      case 'dashboard':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navDashboard]} role={tw.role} density={tw.density}>
          <Dashboard onRoute={setRoute} />
        </AppShell>;
      case 'projects':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navProjects]} role={tw.role} density={tw.density}>
          <ProjectsScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'targets':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navProjects, t.navTargets]} role={tw.role} density={tw.density}>
          <TargetsScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'builder':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navAssessments, t.builderTitle || 'Builder']} role={tw.role} density={tw.density}
          actions={<Btn kind="primary" size="sm" onClick={() => setRoute('approval')}>{t.builderSubmit || 'Submit for approval'} →</Btn>}>
          <BuilderScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'approval':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navAssessments, t.approvalTitle || 'Approval']} role={tw.role} density={tw.density}>
          <ApprovalScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'live':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navAssessments, TENSOL_DATA.assessments[0].id]} role={tw.role} density={tw.density}>
          <LiveScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'findings':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navFindings]} role={tw.role} density={tw.density}>
          <FindingsScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'reports':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navReports]} role={tw.role} density={tw.density}>
          <ReportsScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'settings':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={[t.navSettings]} role={tw.role} density={tw.density}>
          <SettingsScreen onRoute={setRoute} role={tw.role} />
        </AppShell>;
      case 'err-403':
      case 'err-404':
      case 'err-500':
        return <AppShell route={route} onRoute={setRoute} breadcrumb={['Error']} role={tw.role} density={tw.density}>
          <ErrorState kind={route.replace('err-', '')} onRoute={setRoute} />
        </AppShell>;
      default:
        return <MarketingPage onSignIn={() => setRoute('login')} onDemo={() => setRoute('login')} monoRatio={tw.monoRatio} redUsage={tw.redUsage} />;
    }
  })();

  return (
    <TensolCtx.Provider value={ctx}>
      <div
        className={isApp ? 'tensol-app' : ''}
        data-theme={tw.theme}
        data-density={tw.density}
        data-screen-label={`${route}`}
      >
        {screen}
      </div>

      <TweaksPanel title="Tweaks · TENSOL">
        <TweakSection title="Locale">
          <TweakRadio label="Language" value={tw.lang} onChange={(v) => setTweak('lang', v)}
            options={[{ value: 'en', label: 'EN' }, { value: 'ru', label: 'RU' }]} />
        </TweakSection>

        <TweakSection title="Navigate">
          <TweakSelect label="Screen" value={route} onChange={setRoute}
            options={[
              { value: 'marketing', label: 'A1 · Landing' },
              { value: 'login', label: 'B2 · Login' },
              { value: 'bootstrap', label: 'B1 · Bootstrap' },
              { value: 'invite', label: 'B3 · Invite signup' },
              { value: 'dashboard', label: 'C1 · Dashboard' },
              { value: 'projects', label: 'C2 · Projects' },
              { value: 'targets', label: 'C3 · Targets' },
              { value: 'builder', label: 'C4 · Assessment builder' },
              { value: 'approval', label: 'C5 · Approval' },
              { value: 'live', label: 'C6 · Live assessment' },
              { value: 'findings', label: 'C7 · Findings + Evidence' },
              { value: 'reports', label: 'C9 · Reports' },
              { value: 'settings', label: 'D1 · Settings' },
              { value: 'err-403', label: 'E3 · 403 RBAC denied' },
              { value: 'err-404', label: 'E3 · 404 not found' },
              { value: 'err-500', label: 'E3 · 5xx server error' },
            ]} />
        </TweakSection>

        <TweakSection title="App theme">
          <TweakRadio label="Theme" value={tw.theme} onChange={(v) => setTweak('theme', v)}
            options={[{ value: 'light', label: 'Paper' }, { value: 'dark', label: 'Ink' }]} />
          <TweakRadio label="Density" value={tw.density} onChange={(v) => setTweak('density', v)}
            options={[{ value: 'comfortable', label: 'Comfort' }, { value: 'compact', label: 'Compact' }]} />
        </TweakSection>

        <TweakSection title="Brand expression">
          <TweakSlider label="Mono dominance" value={tw.monoRatio} min={0.2} max={0.6} step={0.05}
            onChange={(v) => setTweak('monoRatio', v)} format={(v) => `${Math.round(v * 100)}%`} />
          <TweakRadio label="Red usage" value={tw.redUsage} onChange={(v) => setTweak('redUsage', v)}
            options={[{ value: 'reserved', label: 'Reserved' }, { value: 'more', label: 'More' }]} />
        </TweakSection>

        <TweakSection title="Permissions">
          <TweakSelect label="Role" value={tw.role} onChange={(v) => setTweak('role', v)}
            options={[
              { value: 'platform_admin', label: 'platform_admin' },
              { value: 'tenant_admin', label: 'tenant_admin' },
              { value: 'security_lead', label: 'security_lead' },
              { value: 'operator', label: 'operator' },
              { value: 'developer', label: 'developer' },
              { value: 'auditor', label: 'auditor (read-only)' },
              { value: 'viewer', label: 'viewer (read-only)' },
            ]} />
        </TweakSection>
      </TweaksPanel>
    </TensolCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<TensolApp />);
