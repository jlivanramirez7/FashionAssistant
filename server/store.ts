// Storage abstraction (CONTRACTS-v2 "Backends"). Paths follow designdoc
// section 11: users/{uid}, users/{uid}/scans/{id}, users/{uid}/devices/{id},
// users/{uid}/settings/correctionFactors, plus sessions/{sha256(id) hex}.
// All timestamps cross this interface as epoch ms.
import type { CorrectionFactors, DeviceProfile, ScanDoc, UserDoc } from "../src/types.ts";
import type { ScanPatch, UserPatch } from "./validate.ts";

export type { ScanPatch, UserPatch };

export interface SessionRecord {
  uid: string;
  email: string;
  createdAt: number;
  expiresAt: number;
}

/** Stored device doc: the profile plus a server-set updatedAt. */
export type StoredDevice = Partial<DeviceProfile> & { updatedAt?: number };

export interface Store {
  getUser(uid: string): Promise<UserDoc | null>;
  /**
   * Merge `patch` into users/{uid}. On first write fills email (from the
   * session), createdAt (now), units "in", bodyType "unspecified".
   * `heightCm: null` deletes the field. Returns the resulting doc.
   */
  patchUser(uid: string, email: string, patch: UserPatch, now: number): Promise<UserDoc>;

  /** Newest first (createdAt desc), each with `id`. */
  listScans(uid: string): Promise<ScanDoc[]>;
  /**
   * Create a scan. With `clientId` it becomes the doc id and an existing
   * doc with that id is left untouched (idempotent retry). Returns the id.
   */
  createScan(uid: string, scan: ScanDoc, clientId?: string): Promise<string>;
  getScan(uid: string, id: string): Promise<ScanDoc | null>;
  /** Shallow merge; null values delete fields. false when the scan does not exist. */
  patchScan(uid: string, id: string, patch: ScanPatch): Promise<boolean>;
  deleteScan(uid: string, id: string): Promise<void>;

  getDevice(uid: string, deviceId: string): Promise<StoredDevice | null>;
  putDevice(uid: string, deviceId: string, profile: DeviceProfile, now: number): Promise<void>;

  getFactors(uid: string): Promise<CorrectionFactors | null>;
  putFactors(uid: string, factors: CorrectionFactors, now: number): Promise<void>;

  /** users/{uid} and every subcollection. */
  deleteAllForUser(uid: string): Promise<void>;

  /** Sessions are keyed by sha256(session id) hex; the raw id is never stored. */
  createSession(idHash: string, rec: SessionRecord): Promise<void>;
  getSession(idHash: string): Promise<SessionRecord | null>;
  deleteSession(idHash: string): Promise<void>;
  deleteSessionsForUid(uid: string): Promise<void>;

  /** Release connections (graceful shutdown). */
  close(): Promise<void>;
}

/** Applies a validated user patch to an existing (or first) user doc. Pure. */
export function mergeUserDoc(existing: UserDoc | null, email: string, patch: UserPatch, now: number): UserDoc {
  const doc: UserDoc = existing
    ? { ...existing }
    : { email, createdAt: now, units: "in", bodyType: "unspecified" };
  if (patch.units !== undefined) doc.units = patch.units;
  if (patch.bodyType !== undefined) doc.bodyType = patch.bodyType;
  if (patch.heightCm === null) delete doc.heightCm;
  else if (patch.heightCm !== undefined) doc.heightCm = patch.heightCm;
  return doc;
}
