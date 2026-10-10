// App configuration from Vite env (design doc sections 9, 10, 12).
// Nothing here touches the Firebase SDK, so importing it never crashes.

function env(name: string): string {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export const firebaseConfig: {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
} = {
  apiKey: env("VITE_FIREBASE_API_KEY"),
  authDomain: env("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: env("VITE_FIREBASE_PROJECT_ID"),
  appId: env("VITE_FIREBASE_APP_ID"),
  messagingSenderId: env("VITE_FIREBASE_MESSAGING_SENDER_ID"),
};

/** Named Firestore database (not "(default)"). */
export const FIRESTORE_DATABASE_ID: string = env("VITE_FIRESTORE_DATABASE_ID") || "fashionassitant-db";

/** The only account allowed to use the app, lowercased. Empty => nobody is allowed (fail closed). */
export const ALLOWED_EMAIL: string = env("VITE_ALLOWED_EMAIL").toLowerCase();

export const APP_VERSION: string = "0.1.0";

/** False until the web app is registered (apiKey / appId / projectId filled in). */
export function isFirebaseConfigured(): boolean {
  return firebaseConfig.apiKey !== "" && firebaseConfig.appId !== "" && firebaseConfig.projectId !== "";
}
