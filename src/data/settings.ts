// users/{uid}/settings/correctionFactors via the API. `uid` is ignored.

import type { CorrectionFactors } from "../types";
import { api } from "./api";

const PATH = "/api/settings/correctionFactors";

export async function getCorrectionFactors(_uid: string): Promise<CorrectionFactors | null> {
  return api<CorrectionFactors | null>("GET", PATH);
}

/** Replaces the stored factors; updatedAt defaults to now. */
export async function saveCorrectionFactors(_uid: string, f: CorrectionFactors): Promise<void> {
  await api("PUT", PATH, { ...f, updatedAt: f.updatedAt ?? Date.now() });
}
