import { describe, expect, it } from "vitest";
import { MEASUREMENT_SPECS, type CorrectionFactors, type MeasurementKey, type PersonMask } from "../../src/types";
import { ellipseCircumference } from "../../src/measure/ellipse";
import { bottomRow, chordThrough, spanAtRow, topRow } from "../../src/measure/silhouette";
import { findLevels, type LevelInput } from "../../src/measure/levels";
import { computeMeasurements, confidenceFor, robustStats } from "../../src/measure/compute";
import { Body, DEFAULT_CAM, truth } from "./synthetic";
import { sceneFrames, viewDataFor } from "./scene";

const inputs = (heightCm: number, bodyType: "male" | "female" | "unspecified" = "unspecified") => ({
  heightCm,
  bodyType,
  subjectLabel: "me",
});

function maskFromRows(rows: string[]): PersonMask {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (data[y * w + x] = c === "#" ? 1 : 0)));
  return { width: w, height: h, data };
}

describe("ellipseCircumference", () => {
  it("is exact for a circle and matches known ellipse values", () => {
    expect(ellipseCircumference(20, 20)).toBeCloseTo(Math.PI * 20, 9);
    // a = 15, b = 10: exact perimeter 79.3266
    expect(ellipseCircumference(30, 20)).toBeCloseTo(79.3267, 2);
    expect(Math.abs(ellipseCircumference(10, 0) - 20)).toBeLessThan(0.1); // flat ellipse ~ 2 * width (Ramanujan: 19.92)
  });
  it("returns 0 on invalid input", () => {
    expect(ellipseCircumference(NaN, 3)).toBe(0);
    expect(ellipseCircumference(-1, 3)).toBe(0);
  });
});

describe("silhouette", () => {
  const m = maskFromRows([
    "..........",
    ".###..##..",
    "#########.",
    "..........",
  ]);
  it("spanAtRow finds the run containing or nearest to a column", () => {
    expect(spanAtRow(m, 1.5, 2)).toEqual({ u0: 1, u1: 4 });
    expect(spanAtRow(m, 1.2, 6.9)).toEqual({ u0: 6, u1: 8 });
    expect(spanAtRow(m, 1, 5)).toEqual({ u0: 6, u1: 8 }); // nearest (tie -> left searched first? 4 vs 6: |5-3|=2, |5-6|=1)
    expect(spanAtRow(m, 1, 9)).toEqual({ u0: 6, u1: 8 });
    expect(spanAtRow(m, 2, 99)).toEqual({ u0: 0, u1: 9 });
  });
  it("spanAtRow returns null for an empty row, out of range, or an empty mask", () => {
    expect(spanAtRow(m, 0, 3)).toBeNull();
    expect(spanAtRow(m, -1, 3)).toBeNull();
    expect(spanAtRow(m, 4, 3)).toBeNull();
    expect(spanAtRow(m, NaN, 3)).toBeNull();
    expect(spanAtRow({ width: 0, height: 0, data: new Uint8Array(0) }, 0, 0)).toBeNull();
  });
  it("chordThrough measures a diagonal band", () => {
    const W = 200;
    const data = new Uint8Array(W * W);
    // band of perpendicular half-width 10 around the line y = x
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.abs(x + 0.5 - (y + 0.5)) / Math.SQRT2 <= 10) data[y * W + x] = 1;
    const mask = { width: W, height: W, data };
    const c = chordThrough(mask, 100, 100, 1, -1)!;
    expect(Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1])).toBeCloseTo(20, 0);
    expect(chordThrough(mask, 10, 150, 1, 0)).toBeNull(); // starts outside
    expect(chordThrough(mask, 100, 100, 1, -1, 5)).toBeNull(); // longer than the cap
  });
  it("topRow / bottomRow", () => {
    expect(topRow(m)).toBe(1);
    expect(bottomRow(m)).toBe(2);
    expect(topRow(m, 4, 6)).toBe(2);
    expect(topRow({ width: 3, height: 3, data: new Uint8Array(9) })).toBeNull();
  });
});

describe("findLevels", () => {
  it("finds levels on hand-made profiles", () => {
    const step = 0.5;
    const n = 400;
    const y = (i: number) => i * step;
    const input: LevelInput = {
      heightCm: 175,
      stepCm: step,
      frontWidth: Array.from({ length: n }, (_, i) => 28 + 0.01 * (y(i) - 105) ** 2),
      sideDepth: Array.from({ length: n }, (_, i) => 24 - 0.01 * (y(i) - 125) ** 2 + (y(i) < 125 ? 0 : 0)),
      legWidth: Array.from({ length: n }, (_, i) => 11 - 0.02 * (y(i) - 37) ** 2),
      legGap: Array.from({ length: n }, (_, i) => y(i) > 10 && y(i) < 79),
      armSeparated: Array.from({ length: n }, (_, i) => y(i) < 136),
      landmarks: { shoulderY: 143, mouthY: 157, hipY: 91, kneeY: 50, ankleY: 8 },
    };
    const L = findLevels(input);
    expect(L.armpit).toBeCloseTo(135.5, 5);
    expect(L.naturalWaist!).toBeCloseTo(105, 0);
    expect(L.chest!).toBeCloseTo(125, 0);
    expect(L.crotch).toBeCloseTo(78.75, 5); // gap ends in (78.5, 79]
    expect(L.thigh).toBeCloseTo(73.75, 5);
    expect(L.calf!).toBeCloseTo(37, 0);
    expect(L.pantWaist!).toBeCloseTo(91 + 0.4 * (L.naturalWaist! - 91), 9);
    expect(L.fallbacks).toEqual([]);
  });
  it("crotch: knees touching do not stop the search (real scan: inseam read as 38 cm)", () => {
    const step = 0.25;
    const n = 800;
    const y = (i: number) => i * step;
    const base = {
      heightCm: 179, stepCm: step, frontWidth: [], sideDepth: [], legWidth: [], armSeparated: [],
      landmarks: { shoulderY: 147, mouthY: 160, hipY: 94, kneeY: 50, ankleY: 8 },
    };
    // Gap between the ankles, knees touching (44-56 cm), gap again up to the crotch at 82 cm.
    const kneesTouch = findLevels({ ...base, legGap: Array.from({ length: n }, (_, i) => (y(i) > 10 && y(i) < 44) || (y(i) > 56 && y(i) < 82)) });
    expect(kneesTouch.crotch!).toBeCloseTo(81.875, 5);
    expect(kneesTouch.fallbacks).not.toContain("crotch");
    // Thighs touch all the way down to the knees: body-proportion fallback below the hip joint.
    const thighsTouch = findLevels({ ...base, legGap: Array.from({ length: n }, (_, i) => y(i) > 10 && y(i) < 46) });
    expect(thighsTouch.crotch!).toBeCloseTo(94 - 0.06 * 179, 9);
    expect(thighsTouch.fallbacks).toContain("crotch");
    // A one-row speck of background is not a crotch.
    const speck = Array.from({ length: n }, (_, i) => y(i) > 10 && y(i) < 46) as boolean[];
    speck[Math.round(85 / step)] = true;
    expect(findLevels({ ...base, legGap: speck }).fallbacks).toContain("crotch");
  });

  it("uses fallbacks (and says so) when outlines are missing", () => {
    const L = findLevels({
      heightCm: 170,
      stepCm: 0.25,
      frontWidth: [],
      sideDepth: [],
      legWidth: [],
      legGap: [],
      armSeparated: [],
      landmarks: { shoulderY: 140, mouthY: null, hipY: 88, kneeY: 48, ankleY: 8 },
    });
    for (const k of ["neck", "armpit", "naturalWaist", "chest", "crotch", "calf"] as const) {
      expect(Number.isFinite(L[k])).toBe(true);
      expect(L.fallbacks).toContain(k);
    }
  });
  it("returns nulls without landmarks", () => {
    const L = findLevels({
      heightCm: 170, stepCm: 0.25, frontWidth: [], sideDepth: [], legWidth: [], legGap: [], armSeparated: [],
      landmarks: { shoulderY: null, mouthY: null, hipY: null, kneeY: null, ankleY: null },
    });
    expect(L.chest).toBeNull();
    expect(L.crotch).toBeNull();
  });
});

describe("helpers", () => {
  it("robustStats drops an outlier", () => {
    const s = robustStats([10, 10.2, 9.8, 10.1, 30])!;
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(10.025, 6);
  });
  it("confidenceFor maps uncertainty vs target", () => {
    expect(confidenceFor(1.5, 3)).toBeCloseTo(0.75, 9);
    expect(confidenceFor(3, 3)).toBeCloseTo(0.5, 9);
    expect(confidenceFor(10, 3)).toBe(0);
    expect(confidenceFor(5, null)).toBe(1);
  });
});

// ------------------------------------------------------------------ synthetic scans

const CIRC_TOL = 1.0;
const LEN_TOL = 0.5;
const SPECIAL_TOL: Partial<Record<MeasurementKey, number>> = {
  torsoLength: 1.0, // loop estimate = an ellipse perimeter (circumference-like)
  wrist: 1.0,
  // lengths that end at the natural-waist level: the narrowest-width level of an asymmetric
  // waist profile is found within ~0.6 cm (parabola fit on pixel-quantized widths)
  shoulderToWaist: 0.75,
  backLength: 0.75,
};

describe("computeMeasurements on synthetic scans", () => {
  for (const H of [160, 175, 190]) {
    it(`recovers circumferences within ${CIRC_TOL} cm and lengths within ${LEN_TOL} cm (H = ${H})`, () => {
      const body = new Body(H);
      const frames = sceneFrames(body, DEFAULT_CAM, 3, 0.3, H);
      const { measurements, rawMeasurements, levels } = computeMeasurements(viewDataFor(frames, body), inputs(H), null);
      const t = truth(body);
      expect(levels!.fallbacks).toEqual([]);
      expect(measurements.height).toEqual({ valueCm: H, uncertaintyCm: 0, confidence: 1 });
      for (const spec of MEASUREMENT_SPECS) {
        if (spec.key === "height") continue;
        const m = measurements[spec.key];
        expect(m, spec.key).toBeDefined();
        const tol = SPECIAL_TOL[spec.key] ?? (spec.kind === "circumference" ? CIRC_TOL : LEN_TOL);
        expect(Math.abs(m!.valueCm - t.values[spec.key]), `${spec.key}: ${m!.valueCm} vs ${t.values[spec.key]}`).toBeLessThan(tol);
        expect(rawMeasurements[spec.key]).toBeCloseTo(m!.valueCm, 9); // k = 1
        expect(Number.isFinite(m!.uncertaintyCm)).toBe(true);
        expect(m!.confidence).toBeGreaterThanOrEqual(0);
        expect(m!.confidence).toBeLessThanOrEqual(1);
      }
    }, 60_000); // rasterises full-res synthetic scans; ~6 s under a full parallel run
  }

  const body = new Body(175);
  const views = viewDataFor(sceneFrames(body), body);

  it("bust equals chest; alwaysLowConfidence keys are capped at 0.7", () => {
    const { measurements } = computeMeasurements(views, inputs(175, "female"), null);
    expect(measurements.bust).toEqual(measurements.chest);
    for (const spec of MEASUREMENT_SPECS.filter((s) => s.alwaysLowConfidence)) {
      expect(measurements[spec.key]!.confidence).toBeLessThanOrEqual(0.7);
    }
    expect(measurements.chest!.confidence).toBeGreaterThan(0.75);
  });

  it("applies correction factors per body type and keeps raw values", () => {
    const factors: CorrectionFactors = { male: { chest: 1.1, hips: 0.95 }, female: { chest: 2 }, unspecified: {} };
    const plain = computeMeasurements(views, inputs(175, "male"), null);
    const k = computeMeasurements(views, inputs(175, "male"), factors);
    expect(k.measurements.chest!.valueCm).toBeCloseTo(plain.measurements.chest!.valueCm * 1.1, 9);
    expect(k.measurements.hips!.valueCm).toBeCloseTo(plain.measurements.hips!.valueCm * 0.95, 9);
    expect(k.measurements.naturalWaist!.valueCm).toBeCloseTo(plain.measurements.naturalWaist!.valueCm, 9);
    expect(k.rawMeasurements.chest).toBeCloseTo(plain.rawMeasurements.chest!, 9);
    expect(k.measurements.chest!.uncertaintyCm).toBeCloseTo(plain.measurements.chest!.uncertaintyCm * 1.1, 9);
  });

  it("adds the distortion term only without distortionK1", () => {
    const a = computeMeasurements(views, inputs(175), null);
    const b = computeMeasurements(views, inputs(175), null, { hasDistortionK1: true });
    expect(a.measurements.hips!.uncertaintyCm - b.measurements.hips!.uncertaintyCm).toBeCloseTo(0.005 * a.rawMeasurements.hips!, 6);
  });

  it("reports frame spread as uncertainty and drops outlier frames", () => {
    const frames = sceneFrames(body, DEFAULT_CAM, 5, 0.3, 7);
    // corrupt one front frame's shoulder landmarks badly
    const bad = frames.find((f) => f.view === "front")!;
    bad.landmarksPx = bad.landmarksPx.map((l, i) => (i === 11 || i === 12 ? { ...l, y: l.y + 60 } : l));
    const r = computeMeasurements(viewDataFor(frames, body), inputs(175), null);
    const t = truth(body);
    expect(Math.abs(r.measurements.shoulderToWaist!.valueCm - t.values.shoulderToWaist)).toBeLessThan(LEN_TOL);
  });

  it("missing side view: lengths still measured, circumferences omitted", () => {
    const r = computeMeasurements(views.filter((v) => v.view !== "side"), inputs(175), null);
    expect(r.measurements.chest).toBeUndefined();
    expect(r.measurements.thigh).toBeUndefined();
    expect(r.measurements.inseam).toBeDefined();
    expect(r.measurements.bicep).toBeDefined(); // front-only method
  });

  it("missing front view: falls back to the back view", () => {
    const r = computeMeasurements(views.filter((v) => v.view !== "front"), inputs(175), null);
    const t = truth(body);
    expect(Math.abs(r.measurements.naturalWaist!.valueCm - t.values.naturalWaist)).toBeLessThan(CIRC_TOL);
  });

  it("missing landmarks: no NaN, dependent measurements omitted", () => {
    const stripped = views.map((v) => ({
      ...v,
      frames: v.frames.map((f) => ({
        ...f,
        landmarksPx: f.landmarksPx.map((l, i) => ([23, 24, 25, 26, 27, 28].includes(i) ? { ...l, visibility: 0 } : l)),
      })),
    }));
    const r = computeMeasurements(stripped, inputs(175), null);
    expect(r.measurements.inseam).toBeUndefined();
    expect(r.measurements.hips).toBeUndefined();
    for (const m of Object.values(r.measurements)) {
      expect(Number.isFinite(m!.valueCm)).toBe(true);
      expect(Number.isFinite(m!.uncertaintyCm)).toBe(true);
      expect(Number.isFinite(m!.confidence)).toBe(true);
    }
    // all landmarks gone
    const none = views.map((v) => ({ ...v, frames: v.frames.map((f) => ({ ...f, landmarksPx: [] })) }));
    const r2 = computeMeasurements(none, inputs(175), null);
    expect(Object.keys(r2.measurements)).toEqual(["height"]);
  });

  it("empty masks produce no measurements and no NaN", () => {
    const empty = views.map((v) => ({
      ...v,
      frames: v.frames.map((f) => ({ ...f, mask: { ...f.mask, data: new Uint8Array(f.mask.data.length) } })),
    }));
    const r = computeMeasurements(empty, inputs(175), null);
    for (const [k, m] of Object.entries(r.measurements)) {
      expect(Number.isFinite(m!.valueCm), k).toBe(true);
    }
    expect(r.measurements.chest).toBeUndefined();
    expect(r.measurements.shoulderWidth).toBeUndefined();
  });

  it("no views / bad height", () => {
    expect(Object.keys(computeMeasurements([], inputs(175), null).measurements)).toEqual(["height"]);
    expect(computeMeasurements(views, inputs(NaN), null).measurements).toEqual({});
  });
});
