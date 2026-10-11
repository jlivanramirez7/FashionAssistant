// In-memory Store for local development and tests (DATA_BACKEND=memory).
// Data is lost on restart.
import { randomBytes } from "node:crypto";
import type { CorrectionFactors, DeviceProfile, ScanDoc, UserDoc } from "../src/types.ts";
import type { ScanPatch, SessionRecord, Store, StoredDevice, UserPatch } from "./store.ts";
import { mergeUserDoc } from "./store.ts";

interface UserData {
  doc: UserDoc | null;
  scans: Map<string, ScanDoc>;
  devices: Map<string, StoredDevice>;
  factors: CorrectionFactors | null;
}

/** 20-char auto id like Firestore's. */
export function autoId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(20);
  let id = "";
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private users = new Map<string, UserData>();
  private sessions = new Map<string, SessionRecord>();

  private data(uid: string): UserData {
    let d = this.users.get(uid);
    if (!d) {
      d = { doc: null, scans: new Map(), devices: new Map(), factors: null };
      this.users.set(uid, d);
    }
    return d;
  }

  async getUser(uid: string): Promise<UserDoc | null> {
    const doc = this.users.get(uid)?.doc;
    return doc ? clone(doc) : null;
  }

  async patchUser(uid: string, email: string, patch: UserPatch, now: number): Promise<UserDoc> {
    const d = this.data(uid);
    d.doc = mergeUserDoc(d.doc, email, patch, now);
    return clone(d.doc);
  }

  async listScans(uid: string): Promise<ScanDoc[]> {
    const scans = this.users.get(uid)?.scans;
    if (!scans) return [];
    return [...scans.entries()]
      .map(([id, s]) => ({ ...clone(s), id }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async createScan(uid: string, scan: ScanDoc, clientId?: string): Promise<string> {
    const scans = this.data(uid).scans;
    if (clientId !== undefined && scans.has(clientId)) return clientId;
    let id = clientId ?? autoId();
    while (clientId === undefined && scans.has(id)) id = autoId();
    const stored = clone(scan);
    delete stored.id;
    scans.set(id, stored);
    return id;
  }

  async getScan(uid: string, id: string): Promise<ScanDoc | null> {
    const s = this.users.get(uid)?.scans.get(id);
    return s ? { ...clone(s), id } : null;
  }

  async patchScan(uid: string, id: string, patch: ScanPatch): Promise<boolean> {
    const s = this.users.get(uid)?.scans.get(id);
    if (!s) return false;
    const rec = s as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id") continue;
      if (v === null) delete rec[k];
      else if (v !== undefined) rec[k] = clone(v);
    }
    return true;
  }

  async deleteScan(uid: string, id: string): Promise<void> {
    this.users.get(uid)?.scans.delete(id);
  }

  async getDevice(uid: string, deviceId: string): Promise<StoredDevice | null> {
    const dev = this.users.get(uid)?.devices.get(deviceId);
    return dev ? clone(dev) : null;
  }

  async putDevice(uid: string, deviceId: string, profile: DeviceProfile, now: number): Promise<void> {
    this.data(uid).devices.set(deviceId, { ...clone(profile), updatedAt: now });
  }

  async getFactors(uid: string): Promise<CorrectionFactors | null> {
    const f = this.users.get(uid)?.factors;
    return f ? clone(f) : null;
  }

  async putFactors(uid: string, factors: CorrectionFactors, now: number): Promise<void> {
    this.data(uid).factors = { ...clone(factors), updatedAt: factors.updatedAt ?? now };
  }

  async deleteAllForUser(uid: string): Promise<void> {
    this.users.delete(uid);
  }

  async createSession(idHash: string, rec: SessionRecord): Promise<void> {
    this.sessions.set(idHash, { ...rec });
  }

  async getSession(idHash: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(idHash);
    return s ? { ...s } : null;
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async deleteSessionsForUid(uid: string): Promise<void> {
    for (const [k, s] of this.sessions) if (s.uid === uid) this.sessions.delete(k);
  }

  async close(): Promise<void> {}

  /** Test helper: number of stored sessions. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Test helper: whether anything is stored for uid. */
  hasUserData(uid: string): boolean {
    return this.users.has(uid);
  }
}
