import { describe, expect, it } from "vitest";
import {
  chunk,
  deviceFromFirestore,
  deviceToFirestore,
  factorsFromFirestore,
  factorsToFirestore,
  keyNumberMap,
  scanFromFirestore,
  scanPatchToFirestore,
  scanToFirestore,
  sortScansNewestFirst,
  stripUndefined,
  toMillis,
  userFromFirestore,
  userPatchToFirestore,
  type WriteHelpers,
} from "../../src/data/convert";
import type { DeviceProfile, Diagnostics, ScanDoc } from "../../src/types";

/** Fake Timestamp with the SDK's toMillis() shape. */
class FakeTs {
  constructor(readonly ms: number) {}
  toMillis() {
    return this.ms;
  }
}
const DELETE = Symbol("delete");
const h: WriteHelpers = { toTimestamp: (ms) => new FakeTs(ms), deleteField: () => DELETE };

const diagnostics = { userAgent: "UA", processingMs: 1234, distanceM: { front: 2.5 } } as unknown as Diagnostics;

function sampleScan(): ScanDoc {
  return {
    id: "abc",
    createdAt: 1_700_000_000_123,
    status: "complete",
    heightCm: 180,
    bodyType: "female",
    subjectLabel: "Person 3",
    scaleSource: "height+floor",
    deviceId: "dev-1",
    appVersion: "0.1.0",
    viewsCaptured: ["front", "side", "back"],
    measurements: { chest: { valueCm: 98.4, uncertaintyCm: 2.6, confidence: 0.82 } },
    rawMeasurements: { chest: 96.1 },
    tapeMeasurements: { chest: 99 },
    diagnostics,
  };
}

describe("toMillis", () => {
  it("handles numbers, Dates, toMillis() and {seconds,nanoseconds}", () => {
    expect(toMillis(5)).toBe(5);
    expect(toMillis(new Date(42))).toBe(42);
    expect(toMillis(new FakeTs(99))).toBe(99);
    expect(toMillis({ seconds: 2, nanoseconds: 500_000_000 })).toBe(2500);
    expect(toMillis({ seconds: 2 })).toBe(2000);
  });
  it("returns NaN for unknown values", () => {
    expect(toMillis(null)).toBeNaN();
    expect(toMillis(undefined)).toBeNaN();
    expect(toMillis("2024")).toBeNaN();
    expect(toMillis({})).toBeNaN();
  });
});

describe("stripUndefined", () => {
  it("removes undefined recursively and keeps other values", () => {
    const ts = new FakeTs(1);
    expect(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: null, f: [1, undefined, { g: undefined }] }, ts })).toEqual({
      a: 1,
      c: { e: null, f: [1, {}] },
      ts,
    });
  });
  it("keeps class instances untouched", () => {
    const ts = new FakeTs(7);
    expect(stripUndefined({ ts }).ts).toBe(ts);
  });
});

describe("keyNumberMap", () => {
  it("keeps only known keys with numbers", () => {
    expect(keyNumberMap({ chest: 1, bogus: 2, hips: "3", neck: 0 })).toEqual({ chest: 1, neck: 0 });
    expect(keyNumberMap(null)).toEqual({});
    expect(keyNumberMap([1, 2])).toEqual({});
  });
});

describe("scan conversion", () => {
  it("scanToFirestore drops id, converts createdAt and strips undefined", () => {
    const s = sampleScan();
    const out = scanToFirestore({ ...s, tapeMeasurements: undefined }, h);
    expect(out.id).toBeUndefined();
    expect("tapeMeasurements" in out).toBe(false);
    expect(out.createdAt).toBeInstanceOf(FakeTs);
    expect((out.createdAt as FakeTs).ms).toBe(s.createdAt);
    expect(out.measurements).toEqual(s.measurements);
    expect(out.diagnostics).toEqual(diagnostics);
  });

  it("round-trips through Firestore shape", () => {
    const s = sampleScan();
    const back = scanFromFirestore("abc", scanToFirestore(s, h));
    expect(back).toEqual(s);
  });

  it("round-trips a scan without tape values", () => {
    const { tapeMeasurements: _t, ...s } = sampleScan();
    const back = scanFromFirestore("abc", scanToFirestore(s, h));
    expect(back).toEqual(s);
    expect("tapeMeasurements" in back).toBe(false);
  });

  it("scanFromFirestore tolerates missing / malformed fields", () => {
    const s = scanFromFirestore("x", {
      createdAt: { seconds: 10, nanoseconds: 0 },
      status: "weird",
      bodyType: 3,
      viewsCaptured: ["front", "top", "back"],
      measurements: { chest: { valueCm: 90 }, bogus: { valueCm: 1 }, hips: { valueCm: "x" } },
    });
    expect(s.id).toBe("x");
    expect(s.createdAt).toBe(10_000);
    expect(s.status).toBe("complete");
    expect(s.bodyType).toBe("unspecified");
    expect(s.scaleSource).toBe("height");
    expect(s.subjectLabel).toBe("me");
    expect(s.viewsCaptured).toEqual(["front", "back"]);
    expect(s.measurements).toEqual({ chest: { valueCm: 90, uncertaintyCm: 0, confidence: 0 } });
    expect(s.rawMeasurements).toEqual({});
    expect(s.heightCm).toBeNaN();
    expect(s.diagnostics).toEqual({});
    // Pending serverTimestamp / missing createdAt -> 0
    expect(scanFromFirestore("y", {}).createdAt).toBe(0);
  });

  it("scanPatchToFirestore converts createdAt, ignores id, deletes tapeMeasurements on undefined", () => {
    const out = scanPatchToFirestore(
      { id: "zzz", createdAt: 5, subjectLabel: "Person 2", tapeMeasurements: undefined, status: undefined },
      h,
    );
    expect(out).toEqual({ createdAt: new FakeTs(5), subjectLabel: "Person 2", tapeMeasurements: DELETE });
  });

  it("scanPatchToFirestore strips nested undefined", () => {
    const out = scanPatchToFirestore({ tapeMeasurements: { chest: 100, hips: undefined } }, h);
    expect(out).toEqual({ tapeMeasurements: { chest: 100 } });
  });

  it("sortScansNewestFirst sorts by createdAt desc without mutating", () => {
    const a = { ...sampleScan(), id: "a", createdAt: 1 };
    const b = { ...sampleScan(), id: "b", createdAt: 3 };
    const c = { ...sampleScan(), id: "c", createdAt: 2 };
    const input = [a, b, c];
    expect(sortScansNewestFirst(input).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(input.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});

describe("user conversion", () => {
  it("userFromFirestore maps timestamps and defaults", () => {
    expect(userFromFirestore({ email: "a@b.c", createdAt: new FakeTs(7), units: "cm", bodyType: "male", heightCm: 170 })).toEqual({
      email: "a@b.c",
      createdAt: 7,
      units: "cm",
      bodyType: "male",
      heightCm: 170,
    });
    expect(userFromFirestore({})).toEqual({ email: "", createdAt: 0, units: "in", bodyType: "unspecified" });
  });

  it("userPatchToFirestore fills defaults for a new doc, patch wins", () => {
    const out = userPatchToFirestore({ units: "cm", heightCm: 165 }, h, { isNew: true, nowMs: 1000, email: "Me@X.com" });
    expect(out).toEqual({ email: "me@x.com", createdAt: new FakeTs(1000), units: "cm", bodyType: "unspecified", heightCm: 165 });
  });

  it("userPatchToFirestore writes only the patch for an existing doc", () => {
    const out = userPatchToFirestore({ bodyType: "female", heightCm: undefined }, h, { isNew: false, nowMs: 1000 });
    expect(out).toEqual({ bodyType: "female", heightCm: DELETE });
  });
});

describe("device conversion", () => {
  const profile: DeviceProfile = {
    deviceId: "dev-1",
    label: "iPhone Safari",
    deviceModelGuess: "iPhone 14/15 (6.1in)",
    modelSource: "screen-match",
    screen: { width: 390, height: 844, devicePixelRatio: 3 },
    lensOffsetCm: 14,
    lensOffsetSource: "generic",
    front35mmEqMm: 26,
    distortionK1: undefined,
    focalLengthPx: 1500,
    focalLengthSource: "spec",
    captureWidth: 1080,
    captureHeight: 1920,
    calibrationScans: 0,
  };

  it("deviceToFirestore drops deviceId and undefined, adds updatedAt", () => {
    const out = deviceToFirestore(profile, h, 555);
    expect(out.deviceId).toBeUndefined();
    expect("distortionK1" in out).toBe(false);
    expect(out.updatedAt).toEqual(new FakeTs(555));
    expect(out.screen).toEqual(profile.screen);
  });

  it("round-trips back to the profile (minus undefined fields)", () => {
    const back = deviceFromFirestore("dev-1", deviceToFirestore(profile, h, 555));
    const { distortionK1: _k, ...expected } = profile;
    expect(back).toEqual(expected);
  });
});

describe("correction factors conversion", () => {
  it("round-trips and stamps updatedAt", () => {
    const f = { male: { chest: 1.02 }, female: {}, unspecified: { hips: 0.98 } };
    const stored = factorsToFirestore(f, h, 999);
    expect(stored.updatedAt).toEqual(new FakeTs(999));
    expect(factorsFromFirestore(stored)).toEqual({ ...f, updatedAt: 999 });
  });

  it("keeps an explicit updatedAt and drops unknown keys", () => {
    const stored = factorsToFirestore(
      { male: { chest: 1, bogus: 2 } as never, female: {}, unspecified: {}, updatedAt: 5 },
      h,
      999,
    );
    expect(stored).toEqual({ male: { chest: 1 }, female: {}, unspecified: {}, updatedAt: new FakeTs(5) });
  });

  it("factorsFromFirestore handles missing maps and timestamp", () => {
    expect(factorsFromFirestore({})).toEqual({ male: {}, female: {}, unspecified: {} });
  });
});

describe("chunk", () => {
  it("splits into groups of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 500)).toEqual([]);
    const big = Array.from({ length: 1001 }, (_, i) => i);
    expect(chunk(big, 500).map((c) => c.length)).toEqual([500, 500, 1]);
  });
  it("rejects invalid sizes", () => {
    expect(() => chunk([1], 0)).toThrow();
    expect(() => chunk([1], NaN)).toThrow();
  });
});
