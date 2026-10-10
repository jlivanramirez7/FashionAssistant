import { describe, expect, it } from "vitest";
import { buildCamera, focalForFrame } from "../../src/geometry/camera";
import { distort, undistort } from "../../src/geometry/distortion";
import { crownExcessCm, distanceFromFeet, makeViewPlane, rowAtColumn, solveFocalLength } from "../../src/geometry/plane";
import { topRow } from "../../src/measure/silhouette";
import { Body, DEFAULT_CAM, cameraModel, lensHeight, profileFor, project, type SynthCamera } from "./synthetic";
import { maskFor } from "./scene";

const cam = (o: Partial<SynthCamera> = {}): SynthCamera => ({ ...DEFAULT_CAM, ...o });

/** Row/column of the visible head top for a person of height H at distance D (exact tangent). */
function visibleHeadTop(c: SynthCamera, H: number, D: number): [number, number] {
  // tangent line from the lens to the head ellipse (vert c, depth b) in the Y-Z plane
  const body = new Body(H);
  const hd = body.head;
  const h = lensHeight(c);
  // find slope m with |intercept at Z=D| condition: (Yc + sqrt(c^2 + m^2 b^2)) = h + m D
  let lo = 0;
  let hi = 5;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    const lhs = hd.cy + Math.sqrt(hd.vert ** 2 + m * m * hd.depth ** 2);
    if (h + m * D > lhs) hi = m;
    else lo = m;
  }
  const m = (lo + hi) / 2;
  return project(c, 0, h + m * D, D);
}

describe("buildCamera", () => {
  it("derives h, phi, roll and the focal length for the frame", () => {
    const c = cam();
    const p = profileFor(c);
    const m = buildCamera(p, { tiltDeg: 75, rollDeg: 2 }, 1080, 1920);
    expect(m.lensHeightCm).toBeCloseTo(14 * Math.sin((75 * Math.PI) / 180), 9);
    expect(m.phiRad).toBeCloseTo((15 * Math.PI) / 180, 12);
    expect(m.rollRad).toBeCloseTo((2 * Math.PI) / 180, 12);
    expect(m.fx).toBe(c.f);
    expect(m.fy).toBe(c.f);
    expect(m.cx).toBe(540);
    expect(m.cy).toBe(960);
    expect(m.k1).toBe(0);
    // half-size frame -> half the focal length (long-side ratio, as team B rescales)
    const half = buildCamera(p, { tiltDeg: 75, rollDeg: 0 }, 540, 960);
    expect(half.fy).toBeCloseTo(c.f / 2, 9);
    expect(focalForFrame(p, 1920, 1080)).toBeCloseTo(c.f, 9);
  });

  it("uses distortionK1 when present and survives bad orientation values", () => {
    const m = buildCamera(profileFor(cam(), { distortionK1: -0.05 }), { tiltDeg: NaN, rollDeg: NaN }, 1080, 1920);
    expect(m.k1).toBe(-0.05);
    expect(Number.isFinite(m.lensHeightCm)).toBe(true);
    expect(m.phiRad).toBeCloseTo(0, 12);
  });
});

describe("undistort", () => {
  it("is the identity when k1 = 0", () => {
    const m = cameraModel(cam());
    expect(undistort(m, 123.4, 1500.2)).toEqual([123.4, 1500.2]);
  });
  it("inverts distort for k1 != 0", () => {
    for (const k1 of [-0.08, 0.05]) {
      const m = cameraModel(cam(), k1);
      for (const [u, v] of [[10, 20], [540, 960], [1000, 1800], [300, 1500]]) {
        const [du, dv] = distort(m, u, v);
        const [uu, vv] = undistort(m, du, dv);
        expect(uu).toBeCloseTo(u, 6);
        expect(vv).toBeCloseTo(v, 6);
      }
    }
  });
});

describe("distanceFromFeet", () => {
  it("recovers the distance for several tilts and distances", () => {
    for (const thetaDeg of [60, 70, 75, 85]) {
      for (const D of [180, 250, 320]) {
        const c = cam({ thetaDeg });
        const [, v] = project(c, 0, 0, D);
        expect(distanceFromFeet(cameraModel(c), v)).toBeCloseTo(D, 6);
      }
    }
  });

  it("matches the design-doc formula alpha = atan((v - cy)/fy) - phi, d = h / tan(alpha)", () => {
    const c = cam();
    const m = cameraModel(c);
    const v = 1500;
    const alpha = Math.atan((v - m.cy) / m.fy) - m.phiRad;
    expect(distanceFromFeet(m, v)).toBeCloseTo(m.lensHeightCm / Math.tan(alpha), 9);
  });

  it("handles roll, distortion and an off-centre column", () => {
    const c = cam({ rollDeg: 2.5 });
    const k1 = -0.06;
    const [u, v] = project(c, 40, 0, 260, k1);
    expect(distanceFromFeet(cameraModel(c, k1), v, u)).toBeCloseTo(260, 5);
  });

  it("returns 0 (never NaN/Infinity) when the feet are at or above the horizon", () => {
    const m = cameraModel(cam());
    const horizonV = m.cy + m.fy * Math.tan(m.phiRad);
    for (const v of [horizonV, horizonV - 50, 0, -1000, NaN, Infinity]) {
      const d = distanceFromFeet(m, v);
      expect(d).toBe(0);
    }
    expect(distanceFromFeet({ ...m, lensHeightCm: 0 }, 1800)).toBe(0);
    // just below the horizon -> absurd distance -> 0
    expect(distanceFromFeet(m, horizonV + 0.01)).toBe(0);
  });
});

describe("roll convention (team B: positive = top edge toward the phone's +x)", () => {
  it("projects world-up along (sin r, -cos r) in the unmirrored image", () => {
    const r = 3;
    const c = cam({ rollDeg: r });
    const [u0, v0] = project(c, 0, 50, 250);
    const [u1, v1] = project(c, 0, 150, 250);
    const ang = Math.atan2(u1 - u0, -(v1 - v0)) * (180 / Math.PI);
    // projective effects bend it slightly; the sign and size must match
    expect(ang).toBeGreaterThan(r * 0.8);
    expect(ang).toBeLessThan(r * 1.2);
  });

  it("toMetric removes the roll", () => {
    const c = cam({ rollDeg: -2.8 });
    const m = cameraModel(c);
    const [uf, vf] = project(c, 0, 0, 250);
    const H = 175;
    const [uh, vh] = visibleHeadTop(c, H, 250);
    const plane = makeViewPlane(m, "front", vf, vh, H, { uFeet: uf, uHead: uh });
    expect(plane.heightScale).toBeCloseTo(1, 6);
    for (const [X, Y] of [[-40, 30], [35, 120], [0, 100], [50, 160]]) {
      const [u, v] = project(c, X, Y, 250);
      const p = plane.toMetric(u, v);
      expect(p.xCm).toBeCloseTo(X, 4);
      expect(p.yCm).toBeCloseTo(Y, 4);
    }
    // rowAtColumn finds the row for a height at an off-centre column
    const [u, v] = project(c, 45, 110, 250);
    expect(rowAtColumn(plane, u, 110)).toBeCloseTo(v, 3);
  });
});

describe("makeViewPlane", () => {
  it("recovers metric coordinates with heightScale ~1 and agreement ~0 (exact rows)", () => {
    for (const thetaDeg of [62, 75, 84]) {
      const c = cam({ thetaDeg });
      const m = cameraModel(c);
      for (const view of ["front", "back"] as const) {
        const D = 240;
        const H = 168;
        const [, vf] = project(c, 0, 0, D);
        const [, vh] = visibleHeadTop(c, H, D);
        const plane = makeViewPlane(m, view, vf, vh, H);
        expect(plane.distanceCm).toBeCloseTo(D, 6);
        expect(plane.heightScale).toBeCloseTo(1, 6);
        expect(plane.scaleAgreementPct).toBeLessThan(1e-4);
        const [u, v] = project(c, 33, 101, D);
        expect(plane.toMetric(u, v).xCm).toBeCloseTo(33, 5);
        expect(plane.toMetric(u, v).yCm).toBeCloseTo(101, 5);
        expect(plane.rowForHeight(101)).toBeCloseTo(project(c, 0, 101, D)[1], 5);
      }
    }
  });

  it("from a rendered mask head row: heightScale within 0.2%, agreement < 0.2%", () => {
    const c = cam();
    const body = new Body(175);
    for (const view of ["front", "side", "back"] as const) {
      const D = 250;
      const mask = maskFor(body, c, view, D);
      const vHead = topRow(mask)!;
      const [, vf] = project(c, 0, 0, D);
      const plane = makeViewPlane(cameraModel(c), view, vf, vHead, 175);
      expect(Math.abs(plane.heightScale - 1)).toBeLessThan(0.002);
      expect(plane.scaleAgreementPct).toBeLessThan(0.2);
    }
  });

  it("absorbs a wrong lens offset by uniform scaling (metric output stays right)", () => {
    const c = cam();
    const D = 250;
    const H = 175;
    const [, vf] = project(c, 0, 0, D);
    const [, vh] = visibleHeadTop(c, H, D);
    const wrong = { ...cameraModel(c), lensHeightCm: lensHeight(c) * 1.1 };
    const plane = makeViewPlane(wrong, "front", vf, vh, H);
    expect(plane.distanceCm).toBeCloseTo(D * 1.1, 4);
    expect(plane.scaleAgreementPct).toBeGreaterThan(5);
    const [u, v] = project(c, 20, 90, D);
    const p = plane.toMetric(u, v);
    expect(p.xCm).toBeCloseTo(20, 1);
    expect(Math.abs(p.yCm - 90)).toBeLessThan(0.15); // crown term uses the typed height
  });

  it("feet above the horizon: no NaN, height-only distance, flagged with agreement 100", () => {
    const c = cam();
    const m = cameraModel(c);
    const D = 250;
    const [, vh] = visibleHeadTop(c, 175, D);
    const [, vf] = project(c, 0, 0, D);
    // a lens height of 0 makes the floor unusable
    const flat = { ...m, lensHeightCm: -1 };
    const p1 = makeViewPlane(flat, "front", vf, vh, 175);
    expect(Number.isFinite(p1.distanceCm)).toBe(true);
    expect(p1.scaleAgreementPct).toBe(100);
    expect(p1.heightScale).toBe(1);
    // feet row above the horizon
    const p2 = makeViewPlane(m, "front", 10, 5, 175);
    for (const x of [p2.distanceCm, p2.heightScale, p2.scaleAgreementPct, p2.toMetric(500, 500).xCm, p2.toMetric(500, 500).yCm, p2.rowForHeight(100)]) {
      expect(Number.isFinite(x)).toBe(true);
    }
    expect(p2.scaleAgreementPct).toBe(100);
    // NaN rows / height
    const p3 = makeViewPlane(m, "side", NaN, NaN, NaN);
    expect(Number.isFinite(p3.toMetric(1, 1).xCm)).toBe(true);
    expect(Number.isFinite(p3.heightScale)).toBe(true);
  });

  it("crown correction is zero for a level ray and grows with slope", () => {
    expect(crownExcessCm(0, 175, "front")).toBeCloseTo(0, 12);
    expect(crownExcessCm(0.6, 175, "front")).toBeGreaterThan(crownExcessCm(0.6, 175, "side"));
    expect(crownExcessCm(0.6, 175, "front")).toBeGreaterThan(crownExcessCm(0.3, 175, "front"));
  });
});

describe("solveFocalLength", () => {
  it("recovers f within 1% from a wrong starting value (exact rows)", () => {
    for (const thetaDeg of [65, 75, 82]) {
      const c = cam({ thetaDeg });
      const D = 250;
      const H = 175;
      const [, vf] = project(c, 0, 0, D);
      const [, vh] = visibleHeadTop(c, H, D);
      for (const start of [0.85, 1.1, 1.2]) {
        const f = solveFocalLength({ ...cameraModel(c), fx: c.f * start, fy: c.f * start }, vf, vh, H);
        expect(f).not.toBeNull();
        expect(Math.abs(f! / c.f - 1)).toBeLessThan(0.001);
      }
    }
  });

  it("recovers f within 1% from a rendered mask head row", () => {
    const c = cam();
    const body = new Body(182);
    const D = 260;
    const mask = maskFor(body, c, "front", D);
    const vHead = topRow(mask)!;
    const [, vf] = project(c, 0, 0, D);
    const f = solveFocalLength({ ...cameraModel(c), fx: c.f * 1.15, fy: c.f * 1.15 }, vf, vHead, 182);
    expect(Math.abs(f! / c.f - 1)).toBeLessThan(0.01);
  });

  it("returns null without a solution", () => {
    const m = cameraModel(cam());
    expect(solveFocalLength(m, 100, 500, 175)).toBeNull(); // head below feet
    expect(solveFocalLength(m, 1800, 200, 0)).toBeNull();
    expect(solveFocalLength(m, NaN, 200, 175)).toBeNull();
  });
});
