import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Placeholder } from './components/Placeholder.tsx';
import { TensolProvider } from './context.tsx';
import { MarketingPage } from './pages/Marketing.tsx';

// Lazy-loaded screens — files written by parallel agents.
// If a file is missing the lazy import will throw → caught by ErrorBoundary fallback.
const Login = lazy(() => safeImport(() => import('./pages/Login.tsx'), 'login'));
const Bootstrap = lazy(() => safeImport(() => import('./pages/Bootstrap.tsx'), 'bootstrap'));
const Invite = lazy(() => safeImport(() => import('./pages/Invite.tsx'), 'invite'));
const Dashboard = lazy(() => safeImport(() => import('./pages/Dashboard.tsx'), 'dashboard'));
const Projects = lazy(() => safeImport(() => import('./pages/Projects.tsx'), 'projects'));
const Targets = lazy(() => safeImport(() => import('./pages/Targets.tsx'), 'targets'));
const Builder = lazy(() => safeImport(() => import('./pages/Builder.tsx'), 'builder'));
const Approval = lazy(() => safeImport(() => import('./pages/Approval.tsx'), 'approval'));
const Live = lazy(() => safeImport(() => import('./pages/Live.tsx'), 'live'));
const Findings = lazy(() => safeImport(() => import('./pages/Findings.tsx'), 'findings'));
const Reports = lazy(() => safeImport(() => import('./pages/Reports.tsx'), 'reports'));
const Settings = lazy(() => safeImport(() => import('./pages/Settings.tsx'), 'settings'));
const ErrorScreen = lazy(() => safeImport(() => import('./pages/ErrorScreen.tsx'), 'errors'));
const Contact = lazy(() => safeImport(() => import('./pages/Contact.tsx'), 'contact'));
const Pricing = lazy(() => safeImport(() => import('./pages/Pricing.tsx'), 'pricing'));
const Trust = lazy(() => safeImport(() => import('./pages/Trust.tsx'), 'trust'));
const Legal = lazy(() => safeImport(() => import('./pages/Legal.tsx'), 'legal'));
const AuthorizeTarget = lazy(() =>
  safeImport(() => import('./pages/AuthorizeTarget.tsx'), 'authorize'),
);

function safeImport<T extends { default: React.ComponentType<unknown> }>(
  load: () => Promise<T>,
  route: string,
): Promise<T> {
  return load().catch(() => ({
    default: () => (
      <Placeholder
        route={route}
        title="Port pending"
        hint={`This screen has not been ported yet. The design lives at tensol-platform-design/project/src/. Source key: ${route}.`}
      />
    ),
  })) as Promise<T>;
}

const MarketingRoute = () => {
  const navigate = useNavigate();
  return <MarketingPage onSignIn={() => navigate('/login')} onDemo={() => navigate('/contact')} />;
};

export const App = () => (
  <TensolProvider defaultLang="ru">
    <Suspense
      fallback={
        <Placeholder
          route="loading"
          title="Loading…"
          hint="Component lazy-loading from /pages/*.tsx"
        />
      }
    >
      <Routes>
        <Route path="/" element={<MarketingRoute />} />
        <Route path="/login" element={<Login />} />
        <Route path="/bootstrap" element={<Bootstrap />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/targets" element={<Targets />} />
        <Route path="/builder" element={<Builder />} />
        <Route path="/approval" element={<Approval />} />
        <Route path="/live" element={<Live />} />
        <Route path="/findings" element={<Findings />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/err/:kind" element={<ErrorScreen />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/trust" element={<Trust />} />
        <Route path="/legal/:kind" element={<Legal />} />
        <Route
          path="/projects/:projectId/targets/:targetId/authorize"
          element={<AuthorizeTarget />}
        />
        <Route path="*" element={<Navigate to="/err/404" replace />} />
      </Routes>
    </Suspense>
  </TensolProvider>
);
