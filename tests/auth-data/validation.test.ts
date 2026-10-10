import { describe, expect, it } from "vitest";
import {
  computeCorrectionFactors,
  K_RATIO_MAX,
  K_RATIO_MIN,
  tapeScanCount,
  validationStats,
} from "../../src/data/validation";
import type { BodyType, Diagnostics, Measurements, RawMeasurements, ScanDoc, TapeMeasurements } from "../../src/types";

function m(valueCm: number) {
  return { valueCm, uncertaintyCm: 1, confidence: 0.8 };
}

function scan(opts: {
  bodyType?: BodyType;
  measurements?: Measurements;
  raw?: RawMeasurements;
  tape?: TapeMeasurements;
}): ScanDoc {
  return {
    createdAt: 0,
    status: "complete",
    heightCm: 175,
    bodyType: opts.bodyType ?? "male",
    subjectLabel: "me",
    scaleSource: "height",
    deviceId: "d",
    appVersion: "0.1.0",
    viewsCaptured: ["front", "side", "back"],
    measurements: opts.measurements ?? {},
    rawMeasurements: opts.raw ?? {},
    tapeMeasurements: opts.tape,
    diagnostics: {} as Diagnostics,
  };
}

describe("validationStats", () => {
  it("returns [] for no scans", () => {
    expect(validationStats([])).toEqual([]);
  });

  it("ignores scans without tapeMeasurements", () => {
    const s = scan({ measurements: { chest: m(100) } });
    expect(validationStats([s])).toEqual([]);
    expect(validationStats([scan({ measurements: { chest: m(100) }, tape: {} })])).toEqual([]);
  });

  it("computes MAE and % within target per key", () => {
    // chest target 3 cm
    const scans = [
      scan({ measurements: { chest: m(100) }, tape: { chest: 98 } }), // err 2 -> within
      scan({ measurements: { chest: m(95) }, tape: { chest: 100 } }), // err 5 -> out
      scan({ measurements: { chest: m(101) }, tape: { chest: 101 } }), // err 0 -> within
      scan({ measurements: { chest: m(90) }, tape: { chest: 93 } }), // err 3 exactly -> within
    ];
    const rows = validationStats(scans);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("chest");
    expect(rows[0].n).toBe(4);
    expect(rows[0].maeCm).toBeCloseTo((2 + 5 + 0 + 3) / 4, 10);
    expect(rows[0].pctWithinTarget).toBeCloseTo(75, 10);
  });

  it("counts an error exactly at target despite float rounding", () => {
    // neck target 2: 40.1 - 38.1 = 2.0000000000000036
    const rows = validationStats([scan({ measurements: { neck: m(40.1) }, tape: { neck: 38.1 } })]);
    expect(rows[0].pctWithinTarget).toBe(100);
  });

  it("uses measurement-specific targets", () => {
    // wrist target 1.5, hips target 3; error 2 on both
    const rows = validationStats([
      scan({ measurements: { wrist: m(18), hips: m(102) }, tape: { wrist: 16, hips: 100 } }),
    ]);
    const wrist = rows.find((r) => r.key === "wrist")!;
    const hips = rows.find((r) => r.key === "hips")!;
    expect(wrist.pctWithinTarget).toBe(0);
    expect(hips.pctWithinTarget).toBe(100);
  });

  it("skips keys missing on either side and invalid values", () => {
    const rows = validationStats([
      scan({
        measurements: { chest: m(100), naturalWaist: m(80), hips: m(NaN), thigh: m(55) },
        tape: { chest: 99, inseam: 80, hips: 100, thigh: 0 },
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["chest"]);
  });

  it("skips height (no accuracy target)", () => {
    const rows = validationStats([scan({ measurements: { height: m(175) }, tape: { height: 176 } })]);
    expect(rows).toEqual([]);
  });

  it("orders rows by MEASUREMENT_SPECS order and counts n per key", () => {
    const rows = validationStats([
      scan({ measurements: { calf: m(38), neck: m(40) }, tape: { calf: 37, neck: 40 } }),
      scan({ measurements: { neck: m(41) }, tape: { neck: 40 } }),
    ]);
    expect(rows.map((r) => [r.key, r.n])).toEqual([
      ["neck", 2],
      ["calf", 1],
    ]);
    expect(rows[0].maeCm).toBeCloseTo(0.5, 10);
  });

  it("covers length measurements too", () => {
    const rows = validationStats([scan({ measurements: { inseam: m(81) }, tape: { inseam: 80 } })]);
    expect(rows).toEqual([{ key: "inseam", n: 1, maeCm: 1, pctWithinTarget: 100 }]);
  });
});

describe("tapeScanCount", () => {
  it("counts scans with at least one usable tape value", () => {
    expect(
      tapeScanCount([
        scan({ tape: { chest: 100 } }),
        scan({}),
        scan({ tape: {} }),
        scan({ tape: { chest: 0 } }),
        scan({ tape: { neck: 39 } }),
      ]),
    ).toBe(2);
  });
});

describe("computeCorrectionFactors", () => {
  const threeChest = (bodyType: BodyType, pairs: [number, number][]) =>
    pairs.map(([raw, tape]) => scan({ bodyType, raw: { chest: raw }, tape: { chest: tape } }));

  it("returns empty maps with no scans", () => {
    expect(computeCorrectionFactors([])).toEqual({ male: {}, female: {}, unspecified: {} });
  });

  it("k = mean(tape / raw) once minScans samples exist", () => {
    const scans = threeChest("male", [
      [100, 102],
      [100, 104],
      [100, 100],
    ]);
    const f = computeCorrectionFactors(scans);
    expect(f.male.chest).toBeCloseTo((1.02 + 1.04 + 1.0) / 3, 12);
    expect(f.female).toEqual({});
    expect(f.unspecified).toEqual({});
    expect(f.updatedAt).toBeUndefined();
  });

  it("omits keys with fewer than minScans samples", () => {
    const scans = threeChest("male", [
      [100, 102],
      [100, 104],
    ]);
    expect(computeCorrectionFactors(scans).male).toEqual({});
    expect(computeCorrectionFactors(scans, 2).male.chest).toBeCloseTo(1.03, 12);
  });

  it("separates body types", () => {
    const scans = [
      ...threeChest("male", [
        [100, 110],
        [100, 110],
        [100, 110],
      ]),
      ...threeChest("female", [
        [90, 81],
        [90, 81],
        [90, 81],
      ]),
      ...threeChest("unspecified", [
        [100, 100],
        [100, 100],
      ]),
    ];
    const f = computeCorrectionFactors(scans);
    expect(f.male.chest).toBeCloseTo(1.1, 12);
    expect(f.female.chest).toBeCloseTo(0.9, 12);
    expect(f.unspecified).toEqual({});
  });

  it("uses rawMeasurements, not corrected measurements", () => {
    const scans = [1, 2, 3].map(() =>
      scan({ raw: { hips: 100 }, measurements: { hips: m(105) }, tape: { hips: 105 } }),
    );
    expect(computeCorrectionFactors(scans).male.hips).toBeCloseTo(1.05, 12);
  });

  it("only computes circumferences (lengths are ignored)", () => {
    const scans = [1, 2, 3].map(() =>
      scan({ raw: { inseam: 80, shoulderWidth: 45, neck: 38 }, tape: { inseam: 82, shoulderWidth: 46, neck: 39 } }),
    );
    const f = computeCorrectionFactors(scans);
    expect(Object.keys(f.male)).toEqual(["neck"]);
  });

  it("ignores missing/invalid raw or tape values and implausible ratios", () => {
    const scans = [
      scan({ raw: { chest: 100 }, tape: { chest: 101 } }),
      scan({ raw: { chest: 100 }, tape: { chest: 103 } }),
      scan({ raw: { chest: 0 }, tape: { chest: 100 } }),
      scan({ raw: {}, tape: { chest: 100 } }),
      scan({ raw: { chest: 100 }, tape: { chest: 100 * (K_RATIO_MAX + 0.1) } }),
      scan({ raw: { chest: 100 }, tape: { chest: 100 * (K_RATIO_MIN - 0.1) } }),
      scan({ raw: { chest: NaN }, tape: { chest: 100 } }),
      scan({ raw: { chest: 100 } }),
    ];
    expect(computeCorrectionFactors(scans).male).toEqual({});
    const f = computeCorrectionFactors([...scans, scan({ raw: { chest: 100 }, tape: { chest: 102 } })]);
    expect(f.male.chest).toBeCloseTo(1.02, 12);
  });

  it("treats minScans < 1 as 1", () => {
    const f = computeCorrectionFactors(threeChest("female", [[100, 99]]), 0);
    expect(f.female.chest).toBeCloseTo(0.99, 12);
  });
});
