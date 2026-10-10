// "Delete all my data" (design doc section 11): delete every document under
// users/{uid} in batches of <= 500, delete users/{uid}, then clear the local
// Firestore cache and the stored deviceId.

import {
  clearIndexedDbPersistence,
  collection,
  doc,
  getDocsFromServer,
  terminate,
  writeBatch,
  type DocumentReference,
} from "firebase/firestore";
import { getFirebase, _forgetFirestore } from "../auth/firebase";
import { chunk } from "./convert";
import { clearDeviceId } from "./deviceId";

export const SUBCOLLECTIONS = ["scans", "devices", "settings"] as const;
const MAX_BATCH = 500;

export async function deleteAllMyData(uid: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("You are offline. Connect to the internet to delete your data.");
  }
  const { db } = getFirebase();

  // List from the server so documents missing from the local cache are included.
  const refs: DocumentReference[] = [];
  for (const name of SUBCOLLECTIONS) {
    const snap = await getDocsFromServer(collection(db, "users", uid, name));
    for (const d of snap.docs) refs.push(d.ref);
  }
  refs.push(doc(db, "users", uid));

  for (const group of chunk(refs, MAX_BATCH)) {
    const batch = writeBatch(db);
    for (const ref of group) batch.delete(ref);
    await batch.commit();
  }

  // Clear the local cache (requires terminate first). The next getFirebase()
  // creates a fresh Firestore instance.
  await terminate(db);
  _forgetFirestore();
  try {
    await clearIndexedDbPersistence(db);
  } catch (err) {
    // Another tab may still hold the cache open; the server data is gone regardless.
    console.warn("clearIndexedDbPersistence failed", err);
  }
  clearDeviceId();
}
