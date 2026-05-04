import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listAssessments } from '../api/assessments.ts';
import { verifyCheck, verifyStart } from '../api/domains.ts';
import { getProject } from '../api/projects.ts';
import { createTarget, listTargets } from '../api/targets.ts';

interface Props {
  projectId: string;
  onAssessmentClick: (id: string) => void;
  onCredentialsClick?: (targetId: string) => void;
}

interface DomainWizardState {
  token: string;
  instructions: string;
  expires_at: string;
  checkStatus: 'idle' | 'pending' | 'verified';
}

const DomainWizard = ({ targetId }: { targetId: string }) => {
  const [wizard, setWizard] = useState<DomainWizardState | null>(null);

  const startMutation = useMutation({
    mutationFn: () => verifyStart(targetId),
    onSuccess: (data) => {
      setWizard({ ...data, checkStatus: 'idle' });
    },
  });

  const checkMutation = useMutation({
    mutationFn: () => verifyCheck(targetId),
    onSuccess: (data) => {
      setWizard((prev) => (prev ? { ...prev, checkStatus: data.status } : prev));
    },
  });

  if (!wizard) {
    return (
      <button
        type="button"
        data-testid={`domain-verify-start-${targetId}`}
        onClick={() => startMutation.mutate()}
        disabled={startMutation.isPending}
      >
        {startMutation.isPending ? 'Requesting...' : 'Verify Domain'}
      </button>
    );
  }

  return (
    <div data-testid={`domain-wizard-${targetId}`}>
      {wizard.checkStatus === 'verified' ? (
        <span data-testid={`domain-verified-badge-${targetId}`}>Verified</span>
      ) : (
        <>
          <span data-testid={`domain-unverified-badge-${targetId}`}>Unverified</span>
          <p data-testid={`domain-instructions-${targetId}`}>{wizard.instructions}</p>
          <code data-testid={`domain-token-${targetId}`}>{wizard.token}</code>
          <p>Expires: {new Date(wizard.expires_at).toLocaleString()}</p>
          <button
            type="button"
            data-testid={`domain-verify-check-${targetId}`}
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
          >
            {checkMutation.isPending ? 'Checking DNS...' : 'Check DNS Record'}
          </button>
          {wizard.checkStatus === 'pending' && (
            <p data-testid={`domain-not-found-${targetId}`}>
              TXT record not yet detected. Add the record and try again.
            </p>
          )}
        </>
      )}
    </div>
  );
};

const AddTargetForm = ({ projectId }: { projectId: string }) => {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const mutation = useMutation({
    mutationFn: (v: string) => createTarget(projectId, { kind: 'domain', value: v }),
    onSuccess: () => {
      setValue('');
      qc.invalidateQueries({ queryKey: ['targets', projectId] });
    },
  });
  return (
    <form
      data-testid="add-target-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) mutation.mutate(value.trim());
      }}
    >
      <input
        data-testid="add-target-input"
        type="text"
        placeholder="example.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" data-testid="add-target-submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Adding...' : 'Add domain target'}
      </button>
      {mutation.isError && (
        <p data-testid="add-target-error">
          {mutation.error instanceof Error ? mutation.error.message : 'Failed to add target'}
        </p>
      )}
    </form>
  );
};

export const ProjectDetailPage = ({ projectId, onAssessmentClick, onCredentialsClick }: Props) => {
  const { data: projectData, isLoading: loadingProject } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });

  const { data: assessmentsData, isLoading: loadingAssessments } = useQuery({
    queryKey: ['assessments', projectId],
    queryFn: () => listAssessments(projectId),
  });

  const { data: targetsData } = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => listTargets(projectId),
  });

  if (loadingProject || loadingAssessments)
    return <p data-testid="project-detail-loading">Loading...</p>;

  const project = projectData?.project;
  const assessments = assessmentsData?.assessments ?? [];
  const targets = targetsData?.targets ?? [];

  return (
    <div data-testid="project-detail-page">
      <h1>{project?.name ?? 'Project'}</h1>
      <p>{project?.description}</p>

      <h2>Assessments</h2>
      {assessments.length === 0 ? (
        <p data-testid="no-assessments">No assessments yet</p>
      ) : (
        <ul data-testid="assessment-list">
          {assessments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onAssessmentClick(a.id)}
                data-testid={`assessment-item-${a.id}`}
              >
                {a.id} — {a.state}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h2>Targets</h2>
      <AddTargetForm projectId={projectId} />
      {targets.length > 0 && (
        <ul data-testid="target-list">
          {targets.map((t) => (
            <li key={t.id} data-testid={`target-item-${t.id}`}>
              <span>
                {t.kind}: {t.value}
              </span>{' '}
              {t.kind === 'domain' && <DomainWizard targetId={t.id} />}
              {onCredentialsClick && (
                <button
                  type="button"
                  data-testid={`credentials-btn-${t.id}`}
                  onClick={() => onCredentialsClick(t.id)}
                >
                  Credentials
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
