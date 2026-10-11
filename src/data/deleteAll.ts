// "Delete all my data": the server deletes users/{uid} with every
// subcollection and all sessions (and clears the cookie); then local state
// (outbox, deviceId, cached user) is cleared. `uid` is ignored.

import { api, isOffline } from "./api";
import { clearOutbox } from "./outbox";
import { clearDeviceId } from "./deviceId";

const LAST_USER_KEY = "fa.lastUser";

export async function deleteAllMyData(_uid: string): Promise<void> {
  if (isOffline()) throw new Error("You are offline. Connect to the internet to delete your data.");
  await api("DELETE", "/api/me/data");
  clearOutbox();
  clearDeviceId();
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* ignore */
  }
}
