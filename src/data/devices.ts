// users/{uid}/devices/{deviceId} (design doc section 11).

import { doc, getDoc, setDoc } from "firebase/firestore";
import type { DeviceProfile } from "../types";
import { getFirebase } from "../auth/firebase";
import { deviceFromFirestore, deviceToFirestore } from "./convert";
import { writeHelpers } from "./sdk";
import { commitWrite } from "./write";

function deviceRef(uid: string, deviceId: string) {
  return doc(getFirebase().db, "users", uid, "devices", deviceId);
}

export async function getDeviceRecord(uid: string, deviceId: string): Promise<Partial<DeviceProfile> | null> {
  const snap = await getDoc(deviceRef(uid, deviceId));
  return snap.exists() ? deviceFromFirestore(deviceId, snap.data()) : null;
}

export async function saveDeviceRecord(uid: string, profile: DeviceProfile): Promise<void> {
  const data = deviceToFirestore(profile, writeHelpers, Date.now());
  await commitWrite(setDoc(deviceRef(uid, profile.deviceId), data));
}
