// Lazy Firebase initialisation (design doc sections 9, 10).
// Nothing is initialised at import time: the first getFirebase() call does it,
// so the app can show a "not configured" message instead of crashing.

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import { firebaseConfig, FIRESTORE_DATABASE_ID, isFirebaseConfigured } from "../config";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

function createDb(a: FirebaseApp): Firestore {
  // Third argument = the named database; without it the SDK uses "(default)".
  return initializeFirestore(
    a,
    {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    },
    FIRESTORE_DATABASE_ID,
  );
}

export function getFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  if (!isFirebaseConfigured()) {
    throw new Error("Firebase is not configured (VITE_FIREBASE_API_KEY / VITE_FIREBASE_APP_ID are empty).");
  }
  if (!app) app = getApps()[0] ?? initializeApp(firebaseConfig);
  // getAuth() in a browser uses local (IndexedDB) persistence by default.
  if (!auth) auth = getAuth(app);
  if (!db) db = createDb(app);
  return { app, auth, db };
}

/**
 * Forget the Firestore instance after terminate() (used by deleteAllMyData);
 * the next getFirebase() creates a fresh one. Not part of the public contract.
 */
export function _forgetFirestore(): void {
  db = null;
}
