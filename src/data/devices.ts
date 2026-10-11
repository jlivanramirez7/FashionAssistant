// users/{uid}/devices/{deviceId} via /api/devices/:deviceId. `uid` is ignored.

import type { DeviceProfile } from "../types";
import { api, seg } from "./api";

export async function getDeviceRecord(_uid: string, deviceId: string): Promise<Partial<DeviceProfile> | null> {
  return api<Partial<DeviceProfile> | null>("GET", `/api/devices/${seg(deviceId)}`);
}

export async function saveDeviceRecord(_uid: string, profile: DeviceProfile): Promise<void> {
  await api("PUT", `/api/devices/${seg(profile.deviceId)}`, profile);
}
