// users/{uid}/scans/{scanId} (design doc section 11).

import { collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc } from "firebase/firestore";
import type { ScanDoc } from "../types";
import { getFirebase } from "../auth/firebase";
import { scanFromFirestore, scanPatchToFirestore, scanToFirestore, sortScansNewestFirst } from "./convert";
import { writeHelpers } from "./sdk";
import { commitWrite } from "./write";

function scansCol(uid: string) {
  return collection(getFirebase().db, "users", uid, "scans");
}

/** Saves a new scan (auto id, generated locally) and returns the id. Works offline: syncs later. */
export async function saveScan(uid: string, scan: ScanDoc): Promise<string> {
  const ref = doc(scansCol(uid));
  await commitWrite(setDoc(ref, scanToFirestore(scan, writeHelpers)));
  return ref.id;
}

export async function updateScan(uid: string, id: string, patch: Partial<ScanDoc>): Promise<void> {
  const data = scanPatchToFirestore(patch, writeHelpers);
  if (Object.keys(data).length === 0) return;
  await commitWrite(updateDoc(doc(scansCol(uid), id), data));
}

export async function getScan(uid: string, id: string): Promise<ScanDoc | null> {
  const snap = await getDoc(doc(scansCol(uid), id));
  return snap.exists() ? scanFromFirestore(snap.id, snap.data()) : null;
}

/** All scans, newest first. */
export async function listScans(uid: string): Promise<ScanDoc[]> {
  const snap = await getDocs(query(scansCol(uid), orderBy("createdAt", "desc")));
  return sortScansNewestFirst(snap.docs.map((d) => scanFromFirestore(d.id, d.data())));
}

export async function deleteScan(uid: string, id: string): Promise<void> {
  await commitWrite(deleteDoc(doc(scansCol(uid), id)));
}
