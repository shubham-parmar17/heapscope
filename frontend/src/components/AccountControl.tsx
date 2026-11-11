// AccountControl — the single sign-in / sign-out control in the top bar.
import { useAuth } from "../auth/AuthContext";

export function AccountControl() {
  const { user, loading, login, logout } = useAuth();

  if (loading) return <span className="mono dim" data-testid="auth-loading">auth…</span>;

  if (!user) {
    return (
      <button className="btn" onClick={login} data-testid="google-signin-button">
        sign in with Google
      </button>
    );
  }

  return (
    <div className="account" data-testid="account-control">
      {user.picture && (
        <img className="avatar" src={user.picture} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
      <span className="mono" data-testid="account-email">{user.email}</span>
      <button className="btn ghost" onClick={logout} data-testid="signout-button">sign out</button>
    </div>
  );
}
