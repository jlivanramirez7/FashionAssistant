// Google sign-in limited to one account (design doc section 10).

import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { getFirebase } from "./firebase";
import { ALLOWED_EMAIL, firebaseConfig } from "../config";
import { isAllowedFor, shouldUseRedirect, type AuthUserLike } from "./allowlist";

export const PRIVATE_MESSAGE = "This app is private.";

export function isAllowed(user: AuthUserLike | null): boolean {
  return isAllowedFor(user, ALLOWED_EMAIL);
}

async function checkAllowed(user: User | null): Promise<void> {
  if (user && !isAllowed(user)) {
    await signOut(getFirebase().auth);
    throw new Error(PRIVATE_MESSAGE);
  }
}

/** Call once on load, before showing the sign-in screen. */
export async function finishRedirect(): Promise<void> {
  const result = await getRedirectResult(getFirebase().auth);
  await checkAllowed(result?.user ?? null);
}

export async function signIn(): Promise<void> {
  const { auth } = getFirebase();
  const provider = new GoogleAuthProvider();
  if (ALLOWED_EMAIL) provider.setCustomParameters({ login_hint: ALLOWED_EMAIL });
  if (shouldUseRedirect(firebaseConfig.authDomain, location.host)) {
    await signInWithRedirect(auth, provider); // page navigates away
    return;
  }
  const { user } = await signInWithPopup(auth, provider);
  await checkAllowed(user);
}

export async function signOutUser(): Promise<void> {
  await signOut(getFirebase().auth);
}

/** Calls cb with the allowed user, or null (signed out / other account, which is signed out). */
export function watchAuth(cb: (user: { uid: string; email: string } | null) => void): () => void {
  const { auth } = getFirebase();
  return onAuthStateChanged(auth, (user) => {
    if (user && isAllowed(user)) {
      cb({ uid: user.uid, email: user.email ?? "" });
      return;
    }
    if (user) {
      signOut(auth).catch((err) => console.warn("signOut failed", err));
    }
    cb(null);
  });
}
