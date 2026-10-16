import { useCallback } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";

type Doc = Document & { startViewTransition?: (cb: () => void) => unknown };

/** Run a DOM update inside a View Transition when the browser supports it (fluid, blur-to-sharp
 *  morphs between stages); otherwise just apply it. */
export function withTransition(update: () => void) {
  const d = document as Doc;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!d.startViewTransition || reduced) return update();
  d.startViewTransition(() => flushSync(update));
}

/** navigate(), but fluid. */
export function useGo() {
  const nav = useNavigate();
  return useCallback((to: string) => withTransition(() => nav(to)), [nav]);
}
