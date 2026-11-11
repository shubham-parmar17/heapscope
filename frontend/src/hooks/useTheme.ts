// useTheme.ts — dark/light switch via the data-theme attribute on <html>, persisted in localStorage.
// Fires a "themechange" window event so canvas views re-read their palette (canvas can't use CSS).
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "alloclab-theme";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme | null) ?? "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
    window.dispatchEvent(new Event("themechange"));
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

// Re-render counter that bumps on every theme change (for canvas redraws).
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    window.addEventListener("themechange", f);
    return () => window.removeEventListener("themechange", f);
  }, []);
  return tick;
}
