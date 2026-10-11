// Minimal Google Identity Services typings + one-time script loader.

export interface GisIdConfiguration {
  client_id: string;
  ux_mode?: "popup" | "redirect";
  login_uri?: string;
  auto_select?: boolean;
  callback?: (response: { credential: string }) => void;
}

export interface GisButtonOptions {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  width?: number;
}

export interface GoogleAccountsId {
  initialize(config: GisIdConfiguration): void;
  renderButton(parent: HTMLElement, options: GisButtonOptions): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

export const GIS_SRC = "https://accounts.google.com/gsi/client";

let loading: Promise<GoogleAccountsId> | null = null;

/** The GIS id API if the script has already loaded, else null. */
export function gisIfLoaded(): GoogleAccountsId | null {
  return (typeof window !== "undefined" && window.google?.accounts?.id) || null;
}

/** Loads the GIS script once (later calls share the same promise; a failed load can be retried). */
export function loadGis(): Promise<GoogleAccountsId> {
  const ready = gisIfLoaded();
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<GoogleAccountsId>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const id = gisIfLoaded();
      if (id) resolve(id);
      else reject(new Error("Google sign-in did not load."));
    };
    script.onerror = () => reject(new Error("Could not load Google sign-in. Check your connection and try again."));
    document.head.appendChild(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
