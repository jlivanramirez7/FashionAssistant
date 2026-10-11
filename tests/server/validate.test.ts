import { describe, expect, it } from "vitest";
import {
  findImageLikeData,
  isValidId,
  validateDevice,
  validateFactors,
  validateMeasurements,
  validateNewScan,
  validateNumberMap,
  validateScanPatch,
  validateUserPatch,
} from "../../server/validate.ts";
import { sampleDevice, sampleScan } from "./helpers.ts";

describe("ids", () => {
  it("matches ^[A-Za-z0-9_-]{1,64}$", () => {
    expect(isValidId("abc_DEF-123")).toBe(true);
    expect(isValidId("0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e")).toBe(true);
    expect(isValidId("a".repeat(64))).toBe(true);
    for (const bad of ["", "a".repeat(65), "a/b", "a.b", "..", "a b", "é", 42, null]) {
      expect(isValidId(bad), String(bad)).toBe(false);
    }
  });
});

describe("findImageLikeData", () => {
  it("flags long strings, data URLs, huge arrays, nested arrays", () => {
    expect(findImageLikeData({ a: "x".repeat(10_000) })).toBeNull();
    expect(findImageLikeData({ a: "x".repeat(10_001) })).toMatch(/too long/);
    expect(findImageLikeData({ a: { b: ["DATA:image/jpeg;base64,AAAA"] } })).toMatch(/data: URLs/);
    expect(findImageLikeData({ a: " data:text/plain,hi" })).toMatch(/data: URLs/);
    expect(findImageLikeData(new Array(10_001).fill(0))).toMatch(/array too long/);
    expect(findImageLikeData({ a: new Array(10_000).fill(0) })).toBeNull();
    expect(findImageLikeData({ a: [[1, 2]] })).toMatch(/nested arrays/);
    let deep: Record<string, unknown> = {};
    const top = deep;
    for (let i = 0; i < 20; i++) {
      deep.x = {};
      deep = deep.x as Record<string, unknown>;
    }
    expect(findImageLikeData(top)).toMatch(/deeply/);
    expect(findImageLikeData({ ok: "metadata: fine", n: 1, b: true, z: null })).toBeNull();
  });
});

describe("measurement maps", () => {
  it("only MEASUREMENT_KEYS with finite numbers", () => {
    expect(validateNumberMap({ chest: 98, height: 180 }, "m").ok).toBe(true);
    expect(validateNumberMap({ shoeSize: 9 }, "m").ok).toBe(false);
    expect(validateNumberMap({ chest: "98" }, "m").ok).toBe(false);
    expect(validateNumberMap({ chest: Infinity }, "m").ok).toBe(false);
    expect(validateNumberMap({ chest: 0 }, "m", true).ok).toBe(false);
    expect(validateNumberMap([], "m").ok).toBe(false);
    expect(validateNumberMap(JSON.parse('{"__proto__": 1}'), "m").ok).toBe(false);
  });

  it("measurement values need valueCm, uncertaintyCm, confidence", () => {
    expect(validateMeasurements({ chest: { valueCm: 1, uncertaintyCm: 1, confidence: 0.5 } }).ok).toBe(true);
    expect(validateMeasurements({ chest: { valueCm: 1, uncertaintyCm: 1 } }).ok).toBe(false);
    expect(validateMeasurements({ chest: { valueCm: 1, uncertaintyCm: 1, confidence: 0.5, img: "x" } }).ok).toBe(false);
    expect(validateMeasurements({ bogus: { valueCm: 1, uncertaintyCm: 1, confidence: 0.5 } }).ok).toBe(false);
  });
});

describe("validateNewScan / validateScanPatch", () => {
  it("accepts a full scan and a valid clientId; drops id", () => {
    const r = validateNewScan({ ...sampleScan(), id: "x", clientId: "abc-123" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.clientId).toBe("abc-123");
      expect("id" in r.value.scan).toBe(false);
      expect(r.value.scan).toEqual(sampleScan());
    }
  });

  it("rejects missing fields, unknown fields, bad enums, null tape on create", () => {
    const { status: _s, ...noStatus } = sampleScan();
    expect(validateNewScan(noStatus).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), photo: "x" }).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), bodyType: "robot" }).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), viewsCaptured: ["top"] }).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), createdAt: "yesterday" }).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), tapeMeasurements: null }).ok).toBe(false);
    expect(validateNewScan({ ...sampleScan(), clientId: "a/b" }).ok).toBe(false);
    expect(validateNewScan("scan").ok).toBe(false);
  });

  it("patch: partial fields, null tape deletes, clientId not allowed", () => {
    const r = validateScanPatch({ tapeMeasurements: null });
    expect(r).toEqual({ ok: true, value: { tapeMeasurements: null } });
    expect(validateScanPatch({ subjectLabel: "Person 2" }).ok).toBe(true);
    expect(validateScanPatch({ clientId: "abc" }).ok).toBe(false);
    expect(validateScanPatch({ measurements: null }).ok).toBe(false);
    expect(validateScanPatch({ diagnostics: { frame: "data:image/png;base64,AA" } }).ok).toBe(false);
  });
});

describe("validateUserPatch", () => {
  it("allows heightCm/units/bodyType; null height; ignores email/createdAt", () => {
    expect(validateUserPatch({ heightCm: 180, units: "cm", bodyType: "male", email: "x", createdAt: 1 })).toEqual({
      ok: true,
      value: { heightCm: 180, units: "cm", bodyType: "male" },
    });
    expect(validateUserPatch({ heightCm: null })).toEqual({ ok: true, value: { heightCm: null } });
    expect(validateUserPatch({ heightCm: -1 }).ok).toBe(false);
    expect(validateUserPatch({ role: "admin" }).ok).toBe(false);
  });
});

describe("validateDevice / validateFactors", () => {
  it("device: required fields, enums, path id", () => {
    const r = validateDevice(sampleDevice("d1"), "d1");
    expect(r).toEqual({ ok: true, value: sampleDevice("d1") });
    const { deviceId: _d, ...noId } = sampleDevice("d1");
    expect(validateDevice(noId, "d1")).toEqual({ ok: true, value: sampleDevice("d1") });
    expect(validateDevice(sampleDevice("d2"), "d1").ok).toBe(false);
    expect(validateDevice({ ...sampleDevice("d1"), modelSource: "guess" }, "d1").ok).toBe(false);
    expect(validateDevice({ ...sampleDevice("d1"), extra: 1 }, "d1").ok).toBe(false);
    expect(validateDevice({ ...sampleDevice("d1"), screen: { width: 1 } }, "d1").ok).toBe(false);
    const { focalLengthPx: _f, ...noF } = sampleDevice("d1");
    expect(validateDevice(noF, "d1").ok).toBe(false);
  });

  it("factors: three groups of positive finite k per measurement key", () => {
    expect(validateFactors({ male: { chest: 1.1 }, female: {}, unspecified: {}, updatedAt: 5 })).toEqual({
      ok: true,
      value: { male: { chest: 1.1 }, female: {}, unspecified: {}, updatedAt: 5 },
    });
    expect(validateFactors({ male: { chest: 1.1 } })).toEqual({ ok: true, value: { male: { chest: 1.1 }, female: {}, unspecified: {} } });
    expect(validateFactors({ male: { chest: -1 } }).ok).toBe(false);
    expect(validateFactors({ male: { foo: 1 } }).ok).toBe(false);
    expect(validateFactors({ robot: {} }).ok).toBe(false);
  });
});
