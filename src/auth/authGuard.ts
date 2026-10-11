// Sign-in with Google Identity Services (redirect mode) + server session
// (docs/CONTRACTS-v2.md). The server verifies the ID token, enforces the
// allowlist and sets the fa_session cookie.

import { ALLOWED_EMAIL, GOOGLE_CLIENT_ID, isAuthConfigured } from "../config";
import { isAllowedFor, type AuthUserLike } from "./allowlist";
import { gisIfLoaded, loadGis } from "./gis";
import { api, ApiError, NetworkError } from "../data/api";

export const PRIVATE_MESSAGE = "This app is private.";

export interface CurrentUser {
  uid: string;
  email: string;
}

/** Last confirmed user, so the installed app can open offline. Cleared on sign-out / 401 / delete-all. */
const LAST_USER_KEY = "fa.lastUser";

export function isAllowed(user: AuthUserLike | null): boolean {
  return isAllowedFor(user, ALLOWED_EMAIL);
}

/** Reads ?auth_error= (set by the server's sign-in redirect) and removes it from the URL. */
export function readAuthError(): "private" | "failed" | null {
  const url = new URL(location.href);
  if (!url.searchParams.has("auth_error")) return null;
  const value = url.searchParams.get("auth_error");
  url.searchParams.delete("auth_error");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  return value === "private" ? "private" : "failed";
}

/** Renders the official Google button; Google then POSTs the credential to /api/auth/google. */
export async function renderSignInButton(container: HTMLElement): Promise<void> {
  if (!isAuthConfigured()) throw new Error("Sign-in is not configured (VITE_GOOGLE_CLIENT_ID is empty).");
  const gis = await loadGis();
  gis.initialize({
    client_id: GOOGLE_CLIENT_ID,
    ux_mode: "redirect",
    login_uri: location.origin + "/api/auth/google",
    auto_select: false,
  });
  gis.renderButton(container, { theme: "filled_black", size: "large", text: "signin_with", shape: "pill" });
}

function rememberUser(user: CurrentUser | null): void {
  try {
    if (user) localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

function cachedUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as Partial<CurrentUser>;
    return typeof u.uid === "string" && typeof u.email === "string" ? { uid: u.uid, email: u.email } : null;
  } catch {
    return null;
  }
}

/** Forget the cached user (used by delete-all). */
export function forgetCachedUser(): void {
  rememberUser(null);
}

/**
 * GET /api/me. 401 => null. When the network is unreachable, returns the
 * last confirmed user (if any) so the app works offline; else rethrows.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const me = await api<CurrentUser>("GET", "/api/me");
    const user = { uid: me.uid, email: me.email };
    rememberUser(user);
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      rememberUser(null);
      return null;
    }
    if (err instanceof NetworkError) {
      const cached = cachedUser();
      if (cached) return cached;
    }
    throw err;
  }
}

export async function signOutUser(): Promise<void> {
  try {
    await api("POST", "/api/logout");
  } finally {
    rememberUser(null);
    gisIfLoaded()?.disableAutoSelect();
  }
}
