// AuthContext — holds the signed-in user (or null). Sign-in is optional: the lab works without it.
// Checks the backend-owned session cookie when the app starts.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { API } from "../api";

export interface User {
  user_id: string;
  email: string;
  name: string;
  picture: string | null;
}

interface AuthValue {
  user: User | null;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch(`${API}/auth/me`, { credentials: "include" });
      setUser(res.ok ? ((await res.json()) as User) : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = () => {
    window.location.assign(`${API}/auth/google/login`);
  };

  const logout = async () => {
    try {
      await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
    }
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
