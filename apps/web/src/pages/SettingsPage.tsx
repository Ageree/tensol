// S27 — profile-only settings. API token generation deferred to S28 (B-27-tokenuiS28).

interface Props {
  email: string;
  role: string;
  onLogout?: () => void;
}

export const SettingsPage = ({ email, role, onLogout }: Props) => {
  return (
    <div data-testid="settings-page">
      <h1>Settings</h1>

      <section data-testid="profile-section">
        <h2>Profile</h2>
        <p data-testid="profile-email">Email: {email}</p>
        <p data-testid="profile-role">Role: {role}</p>
      </section>

      {onLogout && (
        <section data-testid="account-section">
          <button type="button" onClick={onLogout} data-testid="settings-logout-btn">
            Sign out
          </button>
        </section>
      )}
    </div>
  );
};
