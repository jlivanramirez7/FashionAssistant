import { describe, expect, it } from "vitest";
import {
  averageOrientation,
  eulerToGravity,
  gravityToOrientation,
  normalizeGravity,
  placementOk,
} from "../../src/capture/sensors";

const G = 9.81;
const d2r = Math.PI / 180;
/** Up-vector (spec sign) for a phone tilted theta from flat, rolled r (positive = top toward +x). */
function gravity(thetaDeg: number, rollDeg: number, g = G): [number, number, number] {
  const t = thetaDeg * d2r;
  const r = rollDeg * d2r;
  return [-g * Math.sin(t) * Math.sin(r), g * Math.sin(t) * Math.cos(r), g * Math.cos(t)];
}

describe("gravityToOrientation", () => {
  it("upright portrait -> tilt 90, roll 0", () => {
    const o = gravityToOrientation(0, G, 0);
    expect(o.tiltDeg).toBeCloseTo(90, 6);
    expect(o.rollDeg).toBeCloseTo(0, 6);
  });
  it("leaning back 75 deg", () => {
    const o = gravityToOrientation(...gravity(75, 0));
    expect(o.tiltDeg).toBeCloseTo(75, 6);
    expect(o.rollDeg).toBeCloseTo(0, 6);
    // sanity: matches the long-axis angle above the floor
    const [, gy, gz] = gravity(75, 0);
    expect(Math.atan2(gy, gz) / d2r).toBeCloseTo(75, 6);
  });
  it("flat on its back -> tilt 0, roll 0 (undefined roll reported as 0)", () => {
    const o = gravityToOrientation(0, 0, G);
    expect(o.tiltDeg).toBeCloseTo(0, 6);
    expect(o.rollDeg).toBe(0);
  });
  it("rolled +/-", () => {
    const plus = gravityToOrientation(...gravity(75, 2.5));
    expect(plus.tiltDeg).toBeCloseTo(75, 6);
    expect(plus.rollDeg).toBeCloseTo(2.5, 6);
    const minus = gravityToOrientation(...gravity(70, -10));
    expect(minus.tiltDeg).toBeCloseTo(70, 6);
    expect(minus.rollDeg).toBeCloseTo(-10, 6);
    // top edge toward +x => up vector has a negative x component => positive roll
    expect(gravityToOrientation(-1, G, 0).rollDeg).toBeGreaterThan(0);
  });
  it("is scale invariant", () => {
    const a = gravityToOrientation(...gravity(65, 1, 1));
    const b = gravityToOrientation(...gravity(65, 1, 9.81));
    expect(a.tiltDeg).toBeCloseTo(b.tiltDeg, 9);
    expect(a.rollDeg).toBeCloseTo(b.rollDeg, 9);
  });
  it("leaning forward (face down) gives tilt > 90", () => {
    expect(gravityToOrientation(...gravity(100, 0)).tiltDeg).toBeCloseTo(100, 6);
  });
});

describe("normalizeGravity", () => {
  it("flips an inverted-sign vector (gy < 0)", () => {
    const [x, y, z] = gravity(75, 2);
    const n = normalizeGravity(-x, -y, -z);
    expect(n[0]).toBeCloseTo(x);
    expect(n[1]).toBeCloseTo(y);
    expect(n[2]).toBeCloseTo(z);
    expect(gravityToOrientation(...n).tiltDeg).toBeCloseTo(75, 6);
  });
  it("leaves spec-sign vectors alone", () => {
    expect(normalizeGravity(1, 2, 3)).toEqual([1, 2, 3]);
  });
});

describe("eulerToGravity (deviceorientation fallback)", () => {
  it("beta 90 = upright, beta 0 = flat", () => {
    expect(gravityToOrientation(...eulerToGravity(90, 0)).tiltDeg).toBeCloseTo(90, 6);
    expect(gravityToOrientation(...eulerToGravity(0, 0)).tiltDeg).toBeCloseTo(0, 6);
    const o = gravityToOrientation(...eulerToGravity(75, 0));
    expect(o.tiltDeg).toBeCloseTo(75, 6);
    expect(o.rollDeg).toBeCloseTo(0, 6);
  });
  it("gamma produces a small roll at a normal lean", () => {
    const o = gravityToOrientation(...eulerToGravity(75, 2));
    expect(Math.abs(o.rollDeg)).toBeGreaterThan(0.1);
    expect(Math.abs(o.rollDeg)).toBeLessThan(3);
  });
});

describe("averageOrientation", () => {
  it("averages tilt and roll", () => {
    const o = averageOrientation([
      { tiltDeg: 70, rollDeg: 1 },
      { tiltDeg: 74, rollDeg: -3 },
      { tiltDeg: 72, rollDeg: 2 },
    ]);
    expect(o.tiltDeg).toBeCloseTo(72);
    expect(o.rollDeg).toBeCloseTo(0);
  });
  it("single sample is itself; empty gives NaN", () => {
    expect(averageOrientation([{ tiltDeg: 80, rollDeg: 2 }])).toEqual({ tiltDeg: 80, rollDeg: 2 });
    const e = averageOrientation([]);
    expect(Number.isNaN(e.tiltDeg)).toBe(true);
    expect(Number.isNaN(e.rollDeg)).toBe(true);
  });
});

describe("placementOk", () => {
  it("accepts 60-85 tilt and |roll| <= 3 inclusive", () => {
    expect(placementOk({ tiltDeg: 75, rollDeg: 0 })).toBe(true);
    expect(placementOk({ tiltDeg: 60, rollDeg: 3 })).toBe(true);
    expect(placementOk({ tiltDeg: 85, rollDeg: -3 })).toBe(true);
  });
  it("rejects out-of-range values", () => {
    expect(placementOk({ tiltDeg: 59.9, rollDeg: 0 })).toBe(false);
    expect(placementOk({ tiltDeg: 85.1, rollDeg: 0 })).toBe(false);
    expect(placementOk({ tiltDeg: 90, rollDeg: 0 })).toBe(false);
    expect(placementOk({ tiltDeg: 75, rollDeg: 3.1 })).toBe(false);
    expect(placementOk({ tiltDeg: 75, rollDeg: -3.1 })).toBe(false);
    expect(placementOk({ tiltDeg: NaN, rollDeg: 0 })).toBe(false);
  });
  it("works end to end from gravity", () => {
    expect(placementOk(gravityToOrientation(...gravity(75, 1)))).toBe(true);
    expect(placementOk(gravityToOrientation(...gravity(75, 5)))).toBe(false);
    expect(placementOk(gravityToOrientation(0, G, 0))).toBe(false);
  });
});
