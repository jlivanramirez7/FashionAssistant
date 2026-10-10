// Synthetic scene for the geometry/measure tests: a floor camera at known h/theta/f,
// a parametric person of known height at a known distance, exact 3D projection of
// landmarks, and rasterized PersonMasks per view.
//
// Masks are "slice" renders: a pixel is inside when its ray, intersected with the
// user plane Z = D, lands inside the body's horizontal cross-section at that height
// (the 2.5D model the pipeline assumes). The head is ray-cast as a true 3D ellipsoid,
// because the crown correction in makeViewPlane models exactly that tangent effect.
// The math here is written independently of src/geometry.
import type { CameraModel, DeviceProfile, Landmark, PersonMask, ViewName } from "../../src/types";
import { LM } from "../../src/types";

const DEG = Math.PI / 180;

export interface SynthCamera {
  width: number;
  height: number;
  f: number;
  thetaDeg: number;
  rollDeg: number;
  lensOffsetCm: number;
}

export const DEFAULT_CAM: SynthCamera = {
  width: 1080,
  height: 1920,
  f: 1323,
  thetaDeg: 75,
  rollDeg: 0,
  lensOffsetCm: 14,
};

export function lensHeight(c: SynthCamera): number {
  return c.lensOffsetCm * Math.sin(c.thetaDeg * DEG);
}

export function profileFor(c: SynthCamera, extra: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    deviceId: "test",
    label: "test",
    deviceModelGuess: "synthetic",
    modelSource: "generic",
    screen: { width: 390, height: 844, devicePixelRatio: 3 },
    lensOffsetCm: c.lensOffsetCm,
    lensOffsetSource: "profile",
    front35mmEqMm: 26,
    focalLengthPx: c.f,
    focalLengthSource: "spec",
    captureWidth: c.width,
    captureHeight: c.height,
    calibrationScans: 0,
    ...extra,
  };
}

export function cameraModel(c: SynthCamera, k1 = 0): CameraModel {
  const theta = c.thetaDeg * DEG;
  return {
    width: c.width,
    height: c.height,
    fx: c.f,
    fy: c.f,
    cx: c.width / 2,
    cy: c.height / 2,
    thetaRad: theta,
    phiRad: Math.PI / 2 - theta,
    rollRad: c.rollDeg * DEG,
    lensHeightCm: lensHeight(c),
    k1,
  };
}

/**
 * Project a world point (X right, Y up from the floor, Z forward from the lens foot)
 * to pixels. Roll follows team B: positive = the phone's top edge turned toward its
 * +x side; for the unmirrored front camera (u = -x_device) that rotates the image so
 * world-up appears along (sin r, -cos r) in (u, v).
 */
export function project(c: SynthCamera, X: number, Y: number, Z: number, k1 = 0): [number, number] {
  const phi = (90 - c.thetaDeg) * DEG;
  const h = lensHeight(c);
  const py = Y - h;
  const xc = X;
  const yc = -py * Math.cos(phi) + Z * Math.sin(phi);
  const zc = py * Math.sin(phi) + Z * Math.cos(phi);
  const xl = xc / zc;
  const yl = yc / zc;
  // leveled -> rolled image coords (inverse of the de-roll)
  const r = c.rollDeg * DEG;
  let xn = xl * Math.cos(r) - yl * Math.sin(r);
  let yn = xl * Math.sin(r) + yl * Math.cos(r);
  if (k1) {
    const s = 1 + k1 * (xn * xn + yn * yn);
    xn *= s;
    yn *= s;
  }
  return [c.width / 2 + c.f * xn, c.height / 2 + c.f * yn];
}

// ------------------------------------------------------------------ body model

/** Smooth (cosine) interpolation through keys; zero slope at each key. */
function interp(keys: number[][], y: number, col: number): number {
  if (y <= keys[0][0]) return keys[0][col];
  for (let i = 1; i < keys.length; i++) {
    if (y <= keys[i][0]) {
      const t = (y - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      const w = (1 - Math.cos(Math.PI * t)) / 2;
      return keys[i - 1][col] + w * (keys[i][col] - keys[i - 1][col]);
    }
  }
  return keys[keys.length - 1][col];
}

// (y, half-width lateral, half-depth front-back) at 175 cm
const TORSO = [
  [80, 15, 0.5], [85, 17, 10.8], [88, 18, 12], [91, 17.8, 11.2], [100, 15.5, 10.5],
  [106, 14, 10], [112, 14.5, 10.2], [116, 15.2, 10.6], [119, 15.6, 10.4], [122, 15.9, 11.5],
  [126, 16, 12.5], [133, 17, 12], [138, 19, 11], [143, 20, 9], [146, 17, 7], [147, 12, 5],
];
const LEG = [
  [6, 3.3, 4.0], [8, 3.2, 3.8], [20, 3.6, 4.3], [38, 5.8, 6.0], [44, 5.4, 5.6], [50, 5.2, 5.6],
  [56, 5.6, 6.2], [65, 6.8, 7.4], [75, 8.2, 8.6], [80, 8.5, 8.9], [88, 9, 9.5],
];
const ARM_ANGLE = 35 * DEG;
const UPPER = 30;
const FORE = 26;
const HAND = 8;

export class Body {
  readonly s: number;
  constructor(readonly H: number) {
    this.s = H / 175;
  }
  // all public geometry in cm at this body's scale
  torsoHalf(y: number, depth: boolean): number | null {
    const u = y / this.s;
    if (u < 80 || u > 147) return null;
    return interp(TORSO, u, depth ? 2 : 1) * this.s;
  }
  neckHalf(y: number, depth: boolean): number | null {
    const u = y / this.s;
    if (u < 143 || u > 158) return null;
    const d = u - 150;
    return (depth ? 6 + 0.05 * d * d : 5.8 + 0.06 * d * d) * this.s;
  }
  legX(y: number): number {
    return (9.5 + (2.5 * (88 - Math.min(88, y / this.s))) / 80) * this.s;
  }
  legHalf(y: number, depth: boolean): number | null {
    const u = y / this.s;
    if (u < 6 || u > 88) return null;
    return interp(LEG, u, depth ? 2 : 1) * this.s;
  }
  get shoulderJoint(): [number, number] {
    return [19 * this.s, 143 * this.s];
  }
  get elbow(): [number, number] {
    const [sx, sy] = this.shoulderJoint;
    return [sx + UPPER * this.s * Math.sin(ARM_ANGLE), sy - UPPER * this.s * Math.cos(ARM_ANGLE)];
  }
  get wrist(): [number, number] {
    const [ex, ey] = this.elbow;
    return [ex + FORE * this.s * Math.sin(ARM_ANGLE), ey - FORE * this.s * Math.cos(ARM_ANGLE)];
  }
  /** Arm perpendicular half-width (front) and half-depth at arc length a from the shoulder. */
  armHalf(a: number): { w: number; d: number } | null {
    const U = UPPER * this.s;
    const F = FORE * this.s;
    if (a < 0) return null;
    if (a <= U) {
      const r = (4.2 + 1.0 * Math.sin((Math.PI * a) / U)) * this.s;
      return { w: r, d: r };
    }
    if (a <= U + F) {
      const t = (a - U) / F;
      const r = (4.2 - 1.4 * t) * this.s;
      return { w: r, d: r * (1 + 0.3 * t) };
    }
    if (a <= U + F + HAND * this.s) return { w: 4 * this.s, d: 1.5 * this.s };
    return null;
  }
  /** Lateral (person x >= 0 side) point inside the right/left arm in the front plane? */
  inArmFront(xAbs: number, y: number): boolean {
    const [sx, sy] = this.shoulderJoint;
    const dx = xAbs - sx;
    const dy = y - sy;
    const ax = Math.sin(ARM_ANGLE);
    const ay = -Math.cos(ARM_ANGLE);
    const a = dx * ax + dy * ay;
    const perp = Math.abs(dx * ay - dy * ax);
    const r = this.armHalf(a);
    return !!r && perp <= r.w;
  }
  /** Side view: arms point along the viewing axis; inside if |f| <= arm half-depth at that height. */
  inArmSide(f: number, y: number): boolean {
    const [, sy] = this.shoulderJoint;
    const a = (sy - y) / Math.cos(ARM_ANGLE);
    const r = this.armHalf(a);
    return !!r && Math.abs(f) <= r.d;
  }
  get head(): { cy: number; lat: number; depth: number; vert: number } {
    return { cy: this.H - 0.066 * this.H, lat: 0.043 * this.H, depth: 0.057 * this.H, vert: 0.066 * this.H };
  }

  /** Slice membership at plane coords; lateral = person-x (front/back) or person-forward (side). */
  inside(view: ViewName, c: number, y: number): boolean {
    if (y < 0) return false;
    const side = view === "side";
    const t = this.torsoHalf(y, side);
    if (t !== null && Math.abs(c) <= t) return true;
    const n = this.neckHalf(y, side);
    if (n !== null && Math.abs(c) <= n) return true;
    if (side) {
      const l = this.legHalf(y, true);
      if (l !== null && Math.abs(c) <= l) return true;
      if (this.inArmSide(c, y)) return true;
      return false;
    }
    const lx = this.legX(y);
    const l = this.legHalf(y, false);
    if (l !== null && Math.abs(Math.abs(c) - lx) <= l) return true;
    return this.inArmFront(Math.abs(c), y);
  }

  /** Landmarks in person coords: [lateral x (+ = person's left), y, forward f]. */
  landmarks3d(): Map<number, [number, number, number]> {
    const s = this.s;
    const m = new Map<number, [number, number, number]>();
    const sym = (l: number, r: number, x: number, y: number, f: number) => {
      m.set(l, [x, y, f]);
      m.set(r, [-x, y, f]);
    };
    m.set(LM.nose, [0, 163 * s, 9 * s]);
    sym(LM.leftEar, LM.rightEar, 7.5 * s, 165 * s, 0);
    sym(LM.mouthLeft, LM.mouthRight, 2.5 * s, 157 * s, 8 * s);
    sym(LM.leftShoulder, LM.rightShoulder, this.shoulderJoint[0], this.shoulderJoint[1], 0);
    sym(LM.leftElbow, LM.rightElbow, this.elbow[0], this.elbow[1], 0);
    sym(LM.leftWrist, LM.rightWrist, this.wrist[0], this.wrist[1], 0);
    sym(LM.leftHip, LM.rightHip, 9.5 * s, 91 * s, 0);
    sym(LM.leftKnee, LM.rightKnee, this.legX(50 * s), 50 * s, 0);
    sym(LM.leftAnkle, LM.rightAnkle, this.legX(8 * s), 8 * s, 0);
    sym(LM.leftHeel, LM.rightHeel, this.legX(0), 0, -5 * s);
    sym(LM.leftFootIndex, LM.rightFootIndex, this.legX(0), 0, 20 * s);
    return m;
  }
}

/** Person coords -> world (X, Z) for a view at distance D. */
function toWorld(view: ViewName, x: number, f: number, D: number): [number, number] {
  if (view === "front") return [x, D - f];
  if (view === "back") return [-x, D + f];
  return [f, D + x]; // side: person faces image right, left side farther away
}

export function landmarksPx(
  body: Body,
  cam: SynthCamera,
  view: ViewName,
  D: number,
  jitterPx = 0,
  rand: () => number = Math.random,
  k1 = 0,
): Landmark[] {
  const out: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [i, [x, y, f]] of body.landmarks3d()) {
    const [X, Z] = toWorld(view, x, f, D);
    const [u, v] = project(cam, X, y, Z, k1);
    out[i] = { x: u + jitterPx * (rand() - 0.5) * 2, y: v + jitterPx * (rand() - 0.5) * 2, z: 0, visibility: 0.99 };
  }
  return out;
}

export function normalized(lms: Landmark[], cam: SynthCamera): Landmark[] {
  return lms.map((l) => ({ ...l, x: l.x / cam.width, y: l.y / cam.height }));
}

/** Rasterize the person mask for a view (roll 0, no distortion). */
export function renderMask(body: Body, cam: SynthCamera, view: ViewName, D: number): PersonMask {
  const { width: W, height: Hh, f } = cam;
  const phi = (90 - cam.thetaDeg) * DEG;
  const h = lensHeight(cam);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const data = new Uint8Array(W * Hh);
  const hd = body.head;
  // head ellipsoid semi-axes in world X / Z for this view
  const aX = view === "side" ? hd.depth : hd.lat;
  const aZ = view === "side" ? hd.lat : hd.depth;
  const boxes = footBoxes(body, view, D);
  for (let r = 0; r < Hh; r++) {
    const yn = (r + 0.5 - Hh / 2) / f;
    const dy = sp - yn * cp;
    const dz = cp + yn * sp;
    if (dz <= 0) continue;
    const t = D / dz;
    const Y = h + dy * t;
    for (let i = 0; i < W; i++) {
      const xn = (i + 0.5 - W / 2) / f;
      const X = xn * t;
      const c = view === "back" ? -X : X;
      let inside = body.inside(view, c, Y);
      if (!inside) {
        // ray (xn, dy, dz) from (0, h, 0) vs ellipsoid centred (0, cy, D)
        const ox = 0, oy = h - hd.cy, oz = -D;
        const A = (xn / aX) ** 2 + (dy / hd.vert) ** 2 + (dz / aZ) ** 2;
        const B = 2 * ((ox * xn) / aX ** 2 + (oy * dy) / hd.vert ** 2 + (oz * dz) / aZ ** 2);
        const C = (ox / aX) ** 2 + (oy / hd.vert) ** 2 + (oz / aZ) ** 2 - 1;
        inside = B * B - 4 * A * C >= 0;
      }
      if (!inside) for (const b of boxes) if (rayHitsBox(h, xn, dy, dz, b)) inside = true;
      if (inside) data[r * W + i] = 1;
    }
  }
  return { width: W, height: Hh, data };
}

type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/** Feet as true 3D boxes on the floor (heel f = -5, toe f = +20, ankle above f = 0). */
function footBoxes(body: Body, view: ViewName, D: number): Box[] {
  const s = body.s;
  const out: Box[] = [];
  for (const sgn of [1, -1]) {
    const xc = sgn * body.legX(0);
    const xs = [xc - 4.5 * s, xc + 4.5 * s];
    const fs = [-5 * s, 20 * s];
    const w = (x: number, f: number) => toWorld(view, x, f, D);
    const pts = [w(xs[0], fs[0]), w(xs[0], fs[1]), w(xs[1], fs[0]), w(xs[1], fs[1])];
    out.push({
      x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
      y0: 0, y1: 6 * s,
      z0: Math.min(...pts.map((p) => p[1])), z1: Math.max(...pts.map((p) => p[1])),
    });
  }
  return out;
}

function rayHitsBox(h: number, dx: number, dy: number, dz: number, b: Box): boolean {
  let t0 = 0;
  let t1 = Infinity;
  const o = [0, h, 0];
  const d = [dx, dy, dz];
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo[k] || o[k] > hi[k]) return false;
      continue;
    }
    let a = (lo[k] - o[k]) / d[k];
    let c = (hi[k] - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ ground truth

export function ellipseC(w: number, d: number): number {
  const a = w / 2;
  const b = d / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Outer edge (person x >= 0) of the front outline at height y. */
export function outlineEdge(body: Body, y: number): number {
  let x = 0;
  for (let k = 0; k < 200000; k++) {
    const nx = k * 0.001;
    if (body.inside("front", nx, y)) x = nx;
    else if (nx > 30 * body.s && !body.inside("front", nx, y)) break;
  }
  return x;
}

export function truth(body: Body) {
  const s = body.s;
  const L = {
    neck: 150 * s, chest: 126 * s, underbust: 119 * s, naturalWaist: 106 * s, hipJoint: 91 * s,
    hips: 88 * s, crotch: 80 * s, knee: 50 * s, calf: 38 * s, ankle: 8 * s, shoulder: 143 * s, nape: 147 * s,
  };
  const pantWaist = L.hipJoint + 0.4 * (L.naturalWaist - L.hipJoint);
  const thigh = L.crotch - 5;
  const torsoC = (y: number) => ellipseC(2 * body.torsoHalf(y, false)!, 2 * body.torsoHalf(y, true)!);
  const legC = (y: number) => ellipseC(2 * body.legHalf(y, false)!, 2 * body.legHalf(y, true)!);
  const spX = outlineEdge(body, L.shoulder);
  const [ex, ey] = body.elbow;
  const sleeve = Math.hypot(spX - ex, L.shoulder - ey) + 26 * s;
  const wr = body.armHalf((30 + 26) * s - 1e-9)!;
  return {
    levels: { ...L, pantWaist, thigh },
    values: {
      neck: ellipseC(2 * body.neckHalf(L.neck, false)!, 2 * body.neckHalf(L.neck, true)!),
      chest: torsoC(L.chest),
      bust: torsoC(L.chest),
      underbust: torsoC(L.underbust),
      naturalWaist: torsoC(L.naturalWaist),
      pantWaist: torsoC(pantWaist),
      hips: torsoC(L.hips),
      thigh: legC(thigh),
      knee: legC(L.knee),
      calf: legC(L.calf),
      bicep: ellipseC(2 * 5.2 * s, 2 * 5.2 * s),
      wrist: ellipseC(2 * wr.w, 2 * wr.d),
      shoulderWidth: 2 * spX,
      sleeveLength: sleeve,
      shirtSleeve: Math.hypot(spX, L.nape - L.shoulder) + sleeve,
      backLength: L.nape - L.naturalWaist,
      inseam: L.crotch - L.ankle,
      outseam: pantWaist - L.ankle,
      rise: pantWaist - L.crotch,
      shoulderToWaist: L.shoulder - L.naturalWaist,
      torsoLength: ellipseC(L.nape - L.crotch, 2 * body.torsoHalf(L.naturalWaist, true)!),
      footLength: 25 * s,
    } as Record<string, number>,
  };
}
