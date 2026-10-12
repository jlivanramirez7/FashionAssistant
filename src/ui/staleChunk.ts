// After a deploy, an open page can ask for hashed files the server no longer
// has. Detect that and reload ONCE into the new version (never in a loop).

/** A lazily loaded chunk is gone: the app was updated while this page was open. */
export function isStaleChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script/i.test(msg);
}

const STALE_RELOAD_KEY = "fa.staleChunkReload";
const STALE_RELOAD_WINDOW_MS = 60_000;

/**
 * Reload once to pick up the new version. Returns false (no reload) when we
 * already reloaded for this within the last minute, so it can never loop.
 */
export function reloadForNewVersion(now = Date.now(), reload: () => void = () => location.reload()): boolean {
  try {
    const last = Number(sessionStorage.getItem(STALE_RELOAD_KEY) ?? 0);
    if (now - last < STALE_RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    /* no sessionStorage: still reload once per page */
  }
  reload();
  return true;
}
