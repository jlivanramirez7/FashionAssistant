// users/{uid} via GET/PATCH /api/user. `uid` is ignored (server session).

import type { UserDoc } from "../types";
import { api } from "./api";
import { userPatchBody } from "./serialize";

export async function getUserDoc(_uid: string): Promise<UserDoc | null> {
  return api<UserDoc | null>("GET", "/api/user");
}

/** Merge; the server fills email/createdAt/units/bodyType on first write. heightCm: undefined deletes it. */
export async function saveUserDoc(_uid: string, patch: Partial<UserDoc>): Promise<void> {
  await api("PATCH", "/api/user", userPatchBody(patch));
}
