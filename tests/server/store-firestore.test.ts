// Pure doc <-> JSON mapping of the Firestore store (no GCP access).
import { FieldValue, Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import {
  deviceFromFirestore,
  deviceToFirestore,
  factorsFromFirestore,
  factorsToFirestore,
  hasCode,
  scanFromFirestore,
  scanPatchToFirestore,
  scanToFirestore,
  sessionFromFirestore,
  sessionToFirestore,
  toMillis,
  userFromFirestore,
  userToFirestore,
} from "../../server/store-firestore.ts";
import { mergeUserDoc } from "../../server/store.ts";
import { sampleDevice, sampleScan } from "./helpers.ts";

const MS = 1_760_000_000_123;

describe("timestamps", () => {
  it("toMillis handles Timestamp, number, Date, junk", () => {
    expect(toMillis(Timestamp.fromMillis(MS))).toBe(MS);
    expect(toMillis(MS)).toBe(MS);
    expect(toMillis(new Date(MS))).toBe(MS);
    expect(toMillis("x")).toBeUndefined();
    expect(toMillis(NaN)).toBeUndefined();
  });
});

describe("scans", () => {
  it("round-trips with createdAt as Timestamp and no id field", () => {
    const scan = { ...sampleScan({ createdAt: MS }), id: "should-not-be-stored" };
    const doc = scanToFirestore(scan);
    expect(doc.createdAt).toBeInstanceOf(Timestamp);
    expect((doc.createdAt as Timestamp).toMillis()).toBe(MS);
    expect("id" in doc).toBe(false);
    expect(doc.measurements).toEqual(scan.measurements);
    expect(scanFromFirestore("abc", doc)).toEqual({ ...sampleScan({ createdAt: MS }), id: "abc" });
  });

  it("patch: null => FieldValue.delete(), createdAt => Timestamp", () => {
    const u = scanPatchToFirestore({ tapeMeasurements: null, createdAt: MS, status: "partial" });
    expect((u.tapeMeasurements as FieldValue).isEqual(FieldValue.delete())).toBe(true);
    expect((u.createdAt as Timestamp).toMillis()).toBe(MS);
    expect(u.status).toBe("partial");
    expect(scanPatchToFirestore({})).toEqual({});
  });
});

describe("users", () => {
  it("round-trips createdAt", () => {
    const user = { email: "a@b.com", createdAt: MS, units: "cm" as const, bodyType: "female" as const, heightCm: 165 };
    const doc = userToFirestore(user);
    expect((doc.createdAt as Timestamp).toMillis()).toBe(MS);
    expect(userFromFirestore(doc)).toEqual(user);
  });

  it("mergeUserDoc fills defaults on first write, deletes height on null", () => {
    const first = mergeUserDoc(null, "a@b.com", { heightCm: 170 }, MS);
    expect(first).toEqual({ email: "a@b.com", createdAt: MS, units: "in", bodyType: "unspecified", heightCm: 170 });
    const next = mergeUserDoc(first, "other@b.com", { heightCm: null, units: "cm" }, MS + 1);
    expect(next).toEqual({ email: "a@b.com", createdAt: MS, units: "cm", bodyType: "unspecified" });
    expect(first.heightCm).toBe(170); // not mutated
  });
});

describe("devices, factors, sessions", () => {
  it("device updatedAt as Timestamp", () => {
    const doc = deviceToFirestore(sampleDevice("d1"), MS);
    expect((doc.updatedAt as Timestamp).toMillis()).toBe(MS);
    expect(deviceFromFirestore(doc)).toEqual({ ...sampleDevice("d1"), updatedAt: MS });
  });

  it("factors updatedAt (client value or now) and missing groups", () => {
    const doc = factorsToFirestore({ male: { chest: 1.1 }, female: {}, unspecified: {} }, MS);
    expect((doc.updatedAt as Timestamp).toMillis()).toBe(MS);
    expect(factorsFromFirestore(doc)).toEqual({ male: { chest: 1.1 }, female: {}, unspecified: {}, updatedAt: MS });
    const doc2 = factorsToFirestore({ male: {}, female: {}, unspecified: {}, updatedAt: 5 }, MS);
    expect((doc2.updatedAt as Timestamp).toMillis()).toBe(5);
    expect(factorsFromFirestore({ male: { hips: 1 } })).toEqual({ male: { hips: 1 }, female: {}, unspecified: {} });
  });

  it("sessions round-trip; malformed docs => null", () => {
    const rec = { uid: "u", email: "a@b.com", createdAt: MS, expiresAt: MS + 1000 };
    const doc = sessionToFirestore(rec);
    expect(doc.expiresAt).toBeInstanceOf(Timestamp);
    expect(sessionFromFirestore(doc)).toEqual(rec);
    expect(sessionFromFirestore({ uid: "u" })).toBeNull();
  });

  it("hasCode", () => {
    expect(hasCode({ code: 6 }, 6)).toBe(true);
    expect(hasCode(new Error("x"), 6)).toBe(false);
    expect(hasCode(null, 6)).toBe(false);
  });
});
