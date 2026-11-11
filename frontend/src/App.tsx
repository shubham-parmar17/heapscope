// App.tsx — shell: top bar (brand, view switcher, account control) and the active view.
// Backend OAuth callbacks return to the frontend with a session cookie or an auth error query.
import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AccountControl } from "./components/AccountControl";
import { ArenaView } from "./views/ArenaView";
import { PoolView } from "./views/PoolView";
import { FreeListView } from "./views/FreeListView";
import { CompareView } from "./views/CompareView";
import { PointersView } from "./views/PointersView";
import { ScriptView } from "./views/ScriptView";
import { SharedRunView } from "./views/SharedRunView";
import { useTheme } from "./hooks/useTheme";

type View = "arena" | "pool" | "freelist" | "script" | "compare" | "pointers";

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [view, setView] = useState<View>("arena");
  const [theme, toggleTheme] = useTheme();
  const hasAuthError = Boolean(
    (location.state as { authError?: boolean } | null)?.authError ||
    new URLSearchParams(location.search).has("auth_error"),
  );
  const [authError, setAuthError] = useState(hasAuthError);

  useEffect(() => {
    if (hasAuthError) {
      setAuthError(true);
      navigate("/", { replace: true, state: null });
    }
  }, [hasAuthError, navigate]);

  return (
    <>
      <header className="topbar">
        <span className="brand" data-testid="brand">ALLOCATOR LAB</span>
        <nav className="views" aria-label="views">
          {(["arena", "pool", "freelist", "script", "compare", "pointers"] as View[]).map((v) => (
            <button
              key={v}
              className={`tab${view === v ? " active" : ""}`}
              onClick={() => setView(v)}
              data-testid={`view-tab-${v}`}
            >
              {v}
            </button>
          ))}
        </nav>
        <span className="mono dim keys" aria-hidden="true">space = step · r = reset</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={toggleTheme} data-testid="theme-toggle" aria-label="toggle theme">
          {theme === "dark" ? "light" : "dark"}
        </button>
        <AccountControl />
      </header>
      <main className="lab" data-testid="lab-shell">
        {authError && !user && (
          <div className="notice" data-testid="auth-error">
            sign-in failed — try again
            <button className="btn ghost" onClick={() => setAuthError(false)} data-testid="auth-error-dismiss">dismiss</button>
          </div>
        )}
        <div hidden={view !== "arena"}><ArenaView /></div>
        <div hidden={view !== "pool"}><PoolView /></div>
        <div hidden={view !== "freelist"}><FreeListView /></div>
        {view === "script" && <ScriptView />}
        {view === "compare" && <CompareView />}
        {view === "pointers" && <PointersView />}
      </main>
    </>
  );
}

function AppRouter() {
  return (
    <Routes>
      <Route path="/share/:shareId" element={<SharedRunView />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </BrowserRouter>
  );
}
