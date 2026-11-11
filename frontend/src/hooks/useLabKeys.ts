// useLabKeys.ts — shared keyboard binding for the allocator views: Space = step, r = reset.
// Ignored while typing in a form control, when a modifier is held (Ctrl+R must still reload), or
// when the view is hidden behind another tab (offsetParent === null).
import { useEffect, type RefObject } from "react";

export function useLabKeys(anchor: RefObject<HTMLElement | null>, step: () => void, reset: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable) return;
      if (anchor.current?.offsetParent === null) return;
      if (e.code === "Space") { e.preventDefault(); step(); }
      if (e.key === "r") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor, step, reset]);
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
