// Client configuration from Vite env (docs/CONTRACTS-v2.md).
// Only public values live here; Firestore is reached through the server.

function env(name: string): string {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

/** OAuth 2.0 Web client ID for Google Identity Services (public). */
export const GOOGLE_CLIENT_ID: string = env("VITE_GOOGLE_CLIENT_ID");

/** The only account allowed to use the app, lowercased. Empty => nobody is allowed (fail closed). */
export const ALLOWED_EMAIL: string = env("VITE_ALLOWED_EMAIL").toLowerCase();

export const APP_VERSION: string = "0.1.0";

/** False until VITE_GOOGLE_CLIENT_ID is set; the UI then shows a setup message. */
export function isAuthConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== "";
}
