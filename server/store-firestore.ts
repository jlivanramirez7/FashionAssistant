// Firestore Store (DATA_BACKEND=firestore). Uses the Cloud Run service
// account via Application Default Credentials. Paths: designdoc section 11
// plus top-level sessions/{sha256 hex}. The doc <-> JSON mapping functions
// are pure and exported for unit tests.
import { FieldValue, Firestore, Timestamp } from "@google-cloud/firestore";
import type { CorrectionFactors, DeviceProfile, ScanDoc, UserDoc } from "../src/types.ts";
import type { ScanPatch, SessionRecord, Store, StoredDevice, UserPatch } from "./store.ts";
import { mergeUserDoc } from "./store.ts";

type Data = Record<string, unknown>;

// gRPC status codes surfaced by the Firestore client as `err.code`.
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;

export function hasCode(err: unknown, code: number): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

// ---------------------------------------------------------------- pure mapping

/** Firestore Timestamp (or number / Date) -> epoch ms; undefined otherwise. */
export function toMillis(v: unknown): number | undefined {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  return undefined;
}

export function fromMillis(ms: number): Timestamp {
  return Timestamp.fromMillis(ms);
}

/** Replace the named timestamp fields; drops them when not convertible. */
function mapTimes(data: Data, fields: readonly string[], fn: (v: unknown) => unknown): Data {
  const out: Data = { ...data };
  for (const f of fields) {
    if (!(f in out)) continue;
    const v = fn(out[f]);
    if (v === undefined) delete out[f];
    else out[f] = v;
  }
  return out;
}

const toTs = (v: unknown): Timestamp | undefined => {
  const ms = toMillis(v);
  return ms === undefined ? undefined : fromMillis(ms);
};

export function scanToFirestore(scan: ScanDoc): Data {
  const { id: _id, ...rest } = scan;
  return mapTimes(rest as unknown as Data, ["createdAt"], toTs);
}

export function scanFromFirestore(id: string, data: Data): ScanDoc {
  const out = mapTimes(data, ["createdAt"], toMillis) as unknown as ScanDoc;
  return { ...out, id };
}

/** PATCH body -> update() data: null deletes, createdAt -> Timestamp. */
export function scanPatchToFirestore(patch: ScanPatch): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "id") continue;
    if (v === null) out[k] = FieldValue.delete();
    else if (k === "createdAt") out[k] = fromMillis(v as number);
    else out[k] = v;
  }
  return out;
}

export function userToFirestore(doc: UserDoc): Data {
  return mapTimes(doc as unknown as Data, ["createdAt"], toTs);
}

export function userFromFirestore(data: Data): UserDoc {
  return mapTimes(data, ["createdAt"], toMillis) as unknown as UserDoc;
}

export function deviceToFirestore(profile: DeviceProfile, now: number): Data {
  return { ...(profile as unknown as Data), updatedAt: fromMillis(now) };
}

export function deviceFromFirestore(data: Data): StoredDevice {
  return mapTimes(data, ["updatedAt"], toMillis) as StoredDevice;
}

export function factorsToFirestore(f: CorrectionFactors, now: number): Data {
  return { male: f.male, female: f.female, unspecified: f.unspecified, updatedAt: fromMillis(f.updatedAt ?? now) };
}

export function factorsFromFirestore(data: Data): CorrectionFactors {
  const out = mapTimes(data, ["updatedAt"], toMillis) as unknown as CorrectionFactors;
  return { ...out, male: out.male ?? {}, female: out.female ?? {}, unspecified: out.unspecified ?? {} };
}

export function sessionToFirestore(rec: SessionRecord): Data {
  return {
    uid: rec.uid,
    email: rec.email,
    createdAt: fromMillis(rec.createdAt),
    expiresAt: fromMillis(rec.expiresAt),
  };
}

export function sessionFromFirestore(data: Data): SessionRecord | null {
  const createdAt = toMillis(data.createdAt);
  const expiresAt = toMillis(data.expiresAt);
  if (typeof data.uid !== "string" || typeof data.email !== "string" || createdAt === undefined || expiresAt === undefined) {
    return null;
  }
  return { uid: data.uid, email: data.email, createdAt, expiresAt };
}

// ---------------------------------------------------------------- store

export class FirestoreStore implements Store {
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  private user(uid: string) {
    return this.db.collection("users").doc(uid);
  }
  private scans(uid: string) {
    return this.user(uid).collection("scans");
  }
  private sessions() {
    return this.db.collection("sessions");
  }

  async getUser(uid: string): Promise<UserDoc | null> {
    const snap = await this.user(uid).get();
    return snap.exists ? userFromFirestore(snap.data() as Data) : null;
  }

  async patchUser(uid: string, email: string, patch: UserPatch, now: number): Promise<UserDoc> {
    const ref = this.user(uid);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? userFromFirestore(snap.data() as Data) : null;
      const merged = mergeUserDoc(existing, email, patch, now);
      // set() without merge replaces the doc, so a deleted heightCm disappears.
      tx.set(ref, userToFirestore(merged));
      return merged;
    });
  }

  async listScans(uid: string): Promise<ScanDoc[]> {
    const qs = await this.scans(uid).orderBy("createdAt", "desc").get();
    return qs.docs.map((d) => scanFromFirestore(d.id, d.data()));
  }

  async createScan(uid: string, scan: ScanDoc, clientId?: string): Promise<string> {
    const data = scanToFirestore(scan);
    if (clientId === undefined) {
      const ref = await this.scans(uid).add(data);
      return ref.id;
    }
    try {
      await this.scans(uid).doc(clientId).create(data);
    } catch (err) {
      if (!hasCode(err, ALREADY_EXISTS)) throw err;
    }
    return clientId;
  }

  async getScan(uid: string, id: string): Promise<ScanDoc | null> {
    const snap = await this.scans(uid).doc(id).get();
    return snap.exists ? scanFromFirestore(snap.id, snap.data() as Data) : null;
  }

  async patchScan(uid: string, id: string, patch: ScanPatch): Promise<boolean> {
    const ref = this.scans(uid).doc(id);
    const update = scanPatchToFirestore(patch);
    if (Object.keys(update).length === 0) return (await ref.get()).exists;
    try {
      await ref.update(update);
      return true;
    } catch (err) {
      if (hasCode(err, NOT_FOUND)) return false;
      throw err;
    }
  }

  async deleteScan(uid: string, id: string): Promise<void> {
    await this.scans(uid).doc(id).delete();
  }

  async getDevice(uid: string, deviceId: string): Promise<StoredDevice | null> {
    const snap = await this.user(uid).collection("devices").doc(deviceId).get();
    return snap.exists ? deviceFromFirestore(snap.data() as Data) : null;
  }

  async putDevice(uid: string, deviceId: string, profile: DeviceProfile, now: number): Promise<void> {
    await this.user(uid).collection("devices").doc(deviceId).set(deviceToFirestore(profile, now));
  }

  async getFactors(uid: string): Promise<CorrectionFactors | null> {
    const snap = await this.user(uid).collection("settings").doc("correctionFactors").get();
    return snap.exists ? factorsFromFirestore(snap.data() as Data) : null;
  }

  async putFactors(uid: string, factors: CorrectionFactors, now: number): Promise<void> {
    await this.user(uid).collection("settings").doc("correctionFactors").set(factorsToFirestore(factors, now));
  }

  async deleteAllForUser(uid: string): Promise<void> {
    // Deletes users/{uid} and every document in its subcollections
    // (scans, devices, settings) through a BulkWriter.
    await this.db.recursiveDelete(this.user(uid));
  }

  async createSession(idHash: string, rec: SessionRecord): Promise<void> {
    await this.sessions().doc(idHash).set(sessionToFirestore(rec));
  }

  async getSession(idHash: string): Promise<SessionRecord | null> {
    const snap = await this.sessions().doc(idHash).get();
    return snap.exists ? sessionFromFirestore(snap.data() as Data) : null;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.sessions().doc(idHash).delete();
  }

  async deleteSessionsForUid(uid: string): Promise<void> {
    const qs = await this.sessions().where("uid", "==", uid).get();
    for (let i = 0; i < qs.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const d of qs.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export function createFirestoreStore(opts: { projectId: string; databaseId: string }): FirestoreStore {
  const db = new Firestore({
    projectId: opts.projectId,
    databaseId: opts.databaseId,
    ignoreUndefinedProperties: true,
  });
  return new FirestoreStore(db);
}
