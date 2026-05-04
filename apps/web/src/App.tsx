import { useState } from 'react';
import { useAuth } from './auth/context.tsx';
import { ProtectedLayout } from './layouts/ProtectedLayout.tsx';
import { AssessmentPage } from './pages/AssessmentPage.tsx';
import { AssessmentTimelinePage } from './pages/AssessmentTimelinePage.tsx';
import { EvidenceViewerPage } from './pages/EvidenceViewerPage.tsx';
import { FindingDetailPage } from './pages/FindingDetailPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ProjectDetailPage } from './pages/ProjectDetailPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { RegisterPage } from './pages/RegisterPage.tsx';
import { ScanProgressPage } from './pages/ScanProgressPage.tsx';
import { ScanWizardPage } from './pages/ScanWizardPage.tsx';
import { TargetCredentialsPage } from './pages/TargetCredentialsPage.tsx';

type Route =
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'assessment'; id: string }
  | { name: 'assessment-timeline'; id: string }
  | { name: 'finding'; id: string }
  | { name: 'evidence'; id: string }
  | { name: 'target-credentials'; id: string }
  | { name: 'scan-wizard'; projectId: string }
  | { name: 'scan-progress'; scanId: string }
  | { name: 'app-projects' };

export const App = () => {
  const { user, loading, logout } = useAuth();
  const [route, setRoute] = useState<Route>({ name: 'projects' });

  if (loading) return <p data-testid="app-loading">Loading...</p>;

  if (route.name === 'register') {
    return (
      <RegisterPage
        onSuccess={() => setRoute({ name: 'app-projects' })}
        onLoginClick={() => setRoute({ name: 'login' })}
      />
    );
  }

  if (!user) {
    return (
      <div>
        <LoginPage onSuccess={() => setRoute({ name: 'projects' })} />
        <p style={{ textAlign: 'center', marginTop: '1rem' }}>
          {"Don't have an account? "}
          <button type="button" onClick={() => setRoute({ name: 'register' })}>
            Sign up
          </button>
        </p>
      </div>
    );
  }

  const nav = (r: Route) => setRoute(r);

  if (route.name === 'app-projects') {
    return (
      <ProtectedLayout onLogout={logout} email={user.actor.email} role={user.actor.role}>
        <ProjectsPage onProjectClick={(id) => nav({ name: 'project', id })} />
      </ProtectedLayout>
    );
  }

  return (
    <div data-testid="app">
      <nav data-testid="app-nav">
        <button type="button" onClick={() => nav({ name: 'projects' })}>
          Projects
        </button>
        <span data-testid="current-user">
          {user.actor.email} ({user.actor.role})
        </span>
        <button type="button" onClick={logout} data-testid="logout-btn">
          Logout
        </button>
      </nav>

      {route.name === 'projects' && (
        <ProjectsPage onProjectClick={(id) => nav({ name: 'project', id })} />
      )}
      {route.name === 'project' && (
        <ProjectDetailPage
          projectId={route.id}
          onAssessmentClick={(id) => nav({ name: 'assessment', id })}
          onCredentialsClick={(id) => nav({ name: 'target-credentials', id })}
        />
      )}
      {route.name === 'assessment' && (
        <AssessmentPage
          assessmentId={route.id}
          onFindingClick={(id) => nav({ name: 'finding', id })}
          onTimelineClick={(id) => nav({ name: 'assessment-timeline', id })}
        />
      )}
      {route.name === 'assessment-timeline' && (
        <AssessmentTimelinePage assessmentId={route.id} kind="all" />
      )}
      {route.name === 'finding' && (
        <FindingDetailPage
          findingId={route.id}
          onEvidenceClick={(id) => nav({ name: 'evidence', id })}
        />
      )}
      {route.name === 'evidence' && <EvidenceViewerPage evidenceId={route.id} />}
      {route.name === 'target-credentials' && <TargetCredentialsPage targetId={route.id} />}
      {route.name === 'scan-wizard' && (
        <ScanWizardPage
          projectId={route.projectId}
          onScanLaunched={(scanId) => nav({ name: 'scan-progress', scanId })}
          onBack={() => nav({ name: 'project', id: route.projectId })}
        />
      )}
      {route.name === 'scan-progress' && (
        <ScanProgressPage scanId={route.scanId} onBack={() => nav({ name: 'projects' })} />
      )}
    </div>
  );
};
