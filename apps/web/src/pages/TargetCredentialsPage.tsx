import { useQuery } from '@tanstack/react-query';
import { type CredentialListItem, listTargetCredentials } from '../api/credentials.ts';

interface Props {
  targetId: string;
  canReadCredentials?: boolean;
}

export const TargetCredentialsPage = ({ targetId, canReadCredentials = true }: Props) => {
  const { data, isLoading } = useQuery({
    queryKey: ['target-credentials', targetId],
    queryFn: () => listTargetCredentials(targetId),
    enabled: canReadCredentials,
  });

  if (!canReadCredentials) {
    return (
      <p data-testid="credentials-forbidden">You do not have permission to view credentials.</p>
    );
  }

  if (isLoading) return <p data-testid="credentials-loading">Loading credentials…</p>;

  const credentials: CredentialListItem[] = data?.credentials ?? [];

  return (
    <div data-testid="target-credentials-page">
      <h2>Stored Credentials</h2>
      {credentials.length === 0 ? (
        <p data-testid="no-credentials">No credentials stored for this target.</p>
      ) : (
        <ul data-testid="credentials-list">
          {credentials.map((cred) => (
            <li key={cred.id} data-testid={`credential-item-${cred.id}`}>
              <span data-testid="cred-name">{cred.name || cred.id}</span>
              {' — '}
              <span data-testid="cred-recipe">{cred.recipeId}</span>
              {' — '}
              <code data-testid="cred-fingerprint">{cred.fingerprintHex}</code>
              {' — '}
              <span data-testid="cred-created">{cred.createdAt}</span>
            </li>
          ))}
        </ul>
      )}
      <p data-testid="credentials-total">Total: {data?.total ?? 0}</p>
    </div>
  );
};
