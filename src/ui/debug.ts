// Dev-only debug capture loader. src/dev/debugCapture.ts (and fflate) is
// only ever imported dynamically, and only on dev builds or ?debug=1, so
// the production bundle's main chunk never pulls it in.
type DebugModule = typeof import("../dev/debugCapture");

let cached: Promise<DebugModule | null> | null = null;

/** The debug module when debug capture is enabled here, else null. */
export function loadDebug(): Promise<DebugModule | null> {
  if (cached) return cached;
  const maybe = import.meta.env.DEV || (typeof location !== "undefined" && location.search.includes("debug=1"));
  cached = maybe
    ? import("../dev/debugCapture").then((m) => (m.debugEnabled() ? m : null)).catch(() => null)
    : Promise.resolve(null);
  return cached;
}
