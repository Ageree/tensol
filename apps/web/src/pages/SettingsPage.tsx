import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type CreateApiTokenResult,
  createApiToken,
  deleteApiToken,
  listApiTokens,
} from '../api/api-tokens.ts';

interface Props {
  email: string;
  role: string;
}

export const SettingsPage = ({ email, role }: Props) => {
  const qc = useQueryClient();
  const [tokenName, setTokenName] = useState('');
  const [newToken, setNewToken] = useState<CreateApiTokenResult | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokensData } = useQuery({
    queryKey: ['api-tokens'],
    queryFn: listApiTokens,
  });

  const createMutation = useMutation({
    mutationFn: () => createApiToken(tokenName.trim()),
    onSuccess: (result) => {
      setNewToken(result);
      setTokenName('');
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteApiToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
  });

  const tokens = tokensData?.tokens ?? [];

  const handleCopy = () => {
    if (newToken) {
      navigator.clipboard.writeText(newToken.token).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div data-testid="settings-page">
      <h1>Settings</h1>

      <section data-testid="profile-section">
        <h2>Profile</h2>
        <p data-testid="profile-email">Email: {email}</p>
        <p data-testid="profile-role">Role: {role}</p>
      </section>

      <section data-testid="api-tokens-section">
        <h2>API Tokens</h2>

        {newToken && (
          <div
            data-testid="new-token-display"
            style={{ background: '#f0fdf4', padding: '1rem', margin: '1rem 0' }}
          >
            <p>Token generated. Copy it now — it will not be shown again.</p>
            <code data-testid="new-token-value">{newToken.token}</code>
            <button type="button" onClick={handleCopy} data-testid="copy-token-btn">
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" onClick={() => setNewToken(null)} data-testid="dismiss-token-btn">
              Dismiss
            </button>
          </div>
        )}

        <form
          data-testid="generate-token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (tokenName.trim()) createMutation.mutate();
          }}
        >
          <input
            type="text"
            placeholder="Token name"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            data-testid="token-name-input"
          />
          <button
            type="submit"
            data-testid="generate-token-btn"
            disabled={createMutation.isPending || !tokenName.trim()}
          >
            {createMutation.isPending ? 'Generating...' : 'Generate New Token'}
          </button>
        </form>

        {createMutation.isError && (
          <p data-testid="generate-token-error">
            {createMutation.error instanceof Error
              ? createMutation.error.message
              : 'Failed to generate token'}
          </p>
        )}

        {tokens.length > 0 && (
          <table data-testid="tokens-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} data-testid={`token-row-${t.id}`}>
                  <td>{t.name}</td>
                  <td>{new Date(t.created_at).toLocaleDateString()}</td>
                  <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
                  <td>{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'Never'}</td>
                  <td>
                    <button
                      type="button"
                      data-testid={`revoke-token-${t.id}`}
                      onClick={() => deleteMutation.mutate(t.id)}
                      disabled={deleteMutation.isPending}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
