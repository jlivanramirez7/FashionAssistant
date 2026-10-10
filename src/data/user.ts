// users/{uid} (design doc section 11).

import { doc, getDoc, setDoc } from "firebase/firestore";
import type { UserDoc } from "../types";
import { getFirebase } from "../auth/firebase";
import { userFromFirestore, userPatchToFirestore } from "./convert";
import { writeHelpers } from "./sdk";
import { commitWrite } from "./write";

function userRef(uid: string) {
  return doc(getFirebase().db, "users", uid);
}

export async function getUserDoc(uid: string): Promise<UserDoc | null> {
  const snap = await getDoc(userRef(uid));
  return snap.exists() ? userFromFirestore(snap.data()) : null;
}

/** Merges `patch` into users/{uid}; creates the doc with defaults (email, createdAt, units, bodyType) if missing. */
export async function saveUserDoc(uid: string, patch: Partial<UserDoc>): Promise<void> {
  const { auth } = getFirebase();
  let isNew = false;
  try {
    isNew = !(await getDoc(userRef(uid))).exists();
  } catch {
    // Offline with nothing cached: write the patch only; defaults are filled on a later save.
  }
  const data = userPatchToFirestore(patch, writeHelpers, {
    isNew,
    nowMs: Date.now(),
    email: patch.email ?? auth.currentUser?.email ?? "",
  });
  await commitWrite(setDoc(userRef(uid), data, { merge: true }));
}
