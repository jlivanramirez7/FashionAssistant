// users/{uid}/settings/correctionFactors (design doc section 11).

import { doc, getDoc, setDoc } from "firebase/firestore";
import type { CorrectionFactors } from "../types";
import { getFirebase } from "../auth/firebase";
import { factorsFromFirestore, factorsToFirestore } from "./convert";
import { writeHelpers } from "./sdk";
import { commitWrite } from "./write";

function factorsRef(uid: string) {
  return doc(getFirebase().db, "users", uid, "settings", "correctionFactors");
}

export async function getCorrectionFactors(uid: string): Promise<CorrectionFactors | null> {
  const snap = await getDoc(factorsRef(uid));
  return snap.exists() ? factorsFromFirestore(snap.data()) : null;
}

/** Replaces the stored factors (no merge: keys dropped from `f` are removed). updatedAt defaults to now. */
export async function saveCorrectionFactors(uid: string, f: CorrectionFactors): Promise<void> {
  await commitWrite(setDoc(factorsRef(uid), factorsToFirestore(f, writeHelpers, Date.now())));
}
