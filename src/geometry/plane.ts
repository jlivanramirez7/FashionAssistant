// Floor distance, metric view plane and focal-length solve (design doc section 4).
//
// World frame: origin on the floor directly below the lens, Y up, Z horizontal along
// the viewing direction, X to the image right. A pixel ray, after undistortion and
// de-rolling, has direction (x, sin(phi) - y cos(phi), cos(phi) + y sin(phi)) where
// (x, y) are the normalized image coords (y down). Its slope T = dY/dZ, and the
// height where it crosses the plane Z = d is Y = h + d * T.
import type { CameraModel, ViewName, ViewPlane } from "../types";
import { distortNormalized, undistort } from "./distortion";
import { withFocalLength } from "./camera";

/** Distances beyond this are treated as undeterminable (feet ~on the horizon). */
export const MAX_DISTANCE_CM = 5000;

/**
 * Head-top ("crown") correction. Seen from a floor camera, the silhouette top of the
 * head is the tangent ray over the skull, which crosses the user plane ABOVE the true
 * crown: excess = sqrt(c^2 + T^2 b^2) - c for a head modelled as an ellipse with
 * vertical semi-axis c and semi-axis b along the viewing direction (T = ray slope).
 * Typical adult proportions as fractions of body height (~11.5, 10, 7.5 cm at 175 cm).
 */
export const HEAD_HALF_HEIGHT_FRAC = 0.066;
/** Front-back semi-axis (the front and back views look along it). */
export const HEAD_HALF_DEPTH_FRAC = 0.057;
/** Ear-to-ear semi-axis (the side view looks along it). */
export const HEAD_HALF_WIDTH_FRAC = 0.043;

export function crownExcessCm(slopeT: number, heightCm: number, view: ViewName): number {
  if (!(heightCm > 0) || !Number.isFinite(slopeT)) return 0;
  const c = HEAD_HALF_HEIGHT_FRAC * heightCm;
  const b = (view === "side" ? HEAD_HALF_WIDTH_FRAC : HEAD_HALF_DEPTH_FRAC) * heightCm;
  return Math.sqrt(c * c + slopeT * slopeT * b * b) - c;
}

/** Ray through pixel (u, v): X/Z ratio and slope T = Y/Z relative to the lens. null if it points backward. */
export function pixelRay(cam: CameraModel, u: number, v: number): { xz: number; slope: number } | null {
  const [uu, vu] = undistort(cam, u, v);
  const xn = (uu - cam.cx) / cam.fx;
  const yn = (vu - cam.cy) / cam.fy;
  const cr = Math.cos(cam.rollRad);
  const sr = Math.sin(cam.rollRad);
  const xl = xn * cr + yn * sr;
  const yl = -xn * sr + yn * cr;
  const sp = Math.sin(cam.phiRad);
  const cp = Math.cos(cam.phiRad);
  const dz = cp + yl * sp;
  if (!(dz > 1e-9) || !Number.isFinite(dz)) return null;
  return { xz: xl / dz, slope: (sp - yl * cp) / dz };
}

/**
 * Horizontal distance (cm) from the lens to where the feet touch the floor.
 * alpha = atan((v - cy)/fy) - phi (depression of the feet ray), d = h / tan(alpha).
 * Returns 0 when it cannot be determined (feet at/above the horizon, h <= 0, d absurd),
 * never NaN or Infinity.
 */
export function distanceFromFeet(cam: CameraModel, vFeet: number, uFeet: number = cam.cx): number {
  if (!Number.isFinite(vFeet) || !Number.isFinite(uFeet) || !(cam.lensHeightCm > 0)) return 0;
  const r = pixelRay(cam, uFeet, vFeet);
  if (!r || !(r.slope < 0)) return 0;
  const d = cam.lensHeightCm / -r.slope;
  return Number.isFinite(d) && d > 0 && d <= MAX_DISTANCE_CM ? d : 0;
}

/** Crown-corrected head height (cm, unscaled) on the plane at distance d. NaN if invalid. */
function geometricHeadHeight(cam: CameraModel, view: ViewName, d: number, vHead: number, uHead: number, heightCm: number): number {
  if (!(d > 0) || !Number.isFinite(vHead)) return NaN;
  const r = pixelRay(cam, uHead, vHead);
  if (!r) return NaN;
  return cam.lensHeightCm + d * r.slope - crownExcessCm(r.slope, heightCm, view);
}

/**
 * Metric plane for one view. The distance comes from the feet row; the head row then
 * gives the geometric height, and heightScale makes it equal the typed height
 * (uniform scale about the floor point, which exactly absorbs an error in h).
 * If the floor geometry fails (feet above the horizon), the plane distance is solved
 * from the typed height alone (heightScale 1) and scaleAgreementPct is 100 to flag it.
 */
export function makeViewPlane(
  cam: CameraModel,
  view: ViewName,
  vFeet: number,
  vHead: number,
  heightCm: number,
  opts: { uFeet?: number; uHead?: number } = {},
): ViewPlane {
  const uFeet = opts.uFeet ?? cam.cx;
  const uHead = opts.uHead ?? cam.cx;
  const h = cam.lensHeightCm;
  const H = heightCm > 0 && Number.isFinite(heightCm) ? heightCm : 0;

  let d = distanceFromFeet(cam, vFeet, uFeet);
  let scale = 1;
  let floorY = 0;
  let agreement = 100;

  const headY = geometricHeadHeight(cam, view, d, vHead, uHead, H);
  if (d > 0 && headY > 0 && H > 0) {
    scale = H / headY;
    agreement = (Math.abs(headY - H) / H) * 100;
  } else {
    const rf = Number.isFinite(vFeet) ? pixelRay(cam, uFeet, vFeet) : null;
    const rh = Number.isFinite(vHead) ? pixelRay(cam, uHead, vHead) : null;
    const denom = rf && rh ? rh.slope - rf.slope : 0;
    if (rf && rh && denom > 1e-9 && H > 0) {
      d = (H + crownExcessCm(rh.slope, H, view)) / denom;
      floorY = h + d * rf.slope;
    } else if (!(d > 0)) {
      d = 250; // nothing usable: nominal distance, flagged by agreement = 100
    }
    if (!(H > 0)) agreement = 0;
  }

  const dist = d;
  const s = scale;
  const fY = floorY;
  return {
    view,
    distanceCm: dist,
    heightScale: s,
    scaleAgreementPct: agreement,
    toMetric(u: number, v: number) {
      const r = pixelRay(cam, u, v);
      if (!r) return { xCm: 0, yCm: 0 };
      return { xCm: r.xz * dist * s, yCm: (h + r.slope * dist - fY) * s };
    },
    rowForHeight(yCm: number) {
      const Y = yCm / s + fY;
      const T = (Y - h) / dist;
      const yl = Math.tan(cam.phiRad - Math.atan(T));
      const cr = Math.cos(cam.rollRad);
      const yn = Math.abs(cr) > 1e-9 ? yl / cr : yl;
      const [, yd] = distortNormalized(cam.k1, 0, yn);
      return cam.cy + yd * cam.fy;
    },
  };
}

/** Row v at column u whose plane point is yCm above the floor (accounts for roll/distortion). */
export function rowAtColumn(plane: ViewPlane, u: number, yCm: number): number {
  let v = plane.rowForHeight(yCm);
  for (let i = 0; i < 3; i++) {
    const y0 = plane.toMetric(u, v).yCm;
    const y1 = plane.toMetric(u, v + 1).yCm;
    const dydv = y1 - y0;
    if (!(Math.abs(dydv) > 1e-9)) break;
    const step = (yCm - y0) / dydv;
    if (!Number.isFinite(step)) break;
    v += step;
    if (Math.abs(step) < 1e-3) break;
  }
  return v;
}

/**
 * Focal length (px) for which the head and feet rays, with the typed height, hit the
 * same vertical plane (design doc section 4, "Focal length"): root of
 * headHeight(f) - H, bracketed on a log grid; the root closest to cam.fy wins.
 * null when there is no solution. Extra optional args (view, columns) are additions
 * to the contract signature.
 */
export function solveFocalLength(
  cam: CameraModel,
  vFeet: number,
  vHead: number,
  heightCm: number,
  view: ViewName = "front",
  opts: { uFeet?: number; uHead?: number } = {},
): number | null {
  if (!(heightCm > 0) || !Number.isFinite(vFeet) || !Number.isFinite(vHead) || !(vFeet > vHead)) return null;
  const uFeet = opts.uFeet ?? cam.cx;
  const uHead = opts.uHead ?? cam.cx;
  const g = (f: number): number => {
    const c = withFocalLength(cam, f);
    const d = distanceFromFeet(c, vFeet, uFeet);
    if (!(d > 0)) return NaN;
    return geometricHeadHeight(c, view, d, vHead, uHead, heightCm) - heightCm;
  };
  const long = Math.max(cam.width, cam.height) || 1000;
  const lo = 0.2 * long;
  const hi = 5 * long;
  const N = 400;
  const roots: number[] = [];
  let pf = lo;
  let pg = g(pf);
  for (let i = 1; i <= N; i++) {
    const f = lo * Math.pow(hi / lo, i / N);
    const gv = g(f);
    if (Number.isFinite(pg) && Number.isFinite(gv) && (pg === 0 || pg * gv < 0)) {
      let a = pf;
      let b = f;
      let ga = pg;
      for (let k = 0; k < 80; k++) {
        const m = 0.5 * (a + b);
        const gm = g(m);
        if (!Number.isFinite(gm)) break;
        if (ga * gm <= 0) b = m;
        else {
          a = m;
          ga = gm;
        }
      }
      roots.push(0.5 * (a + b));
    }
    pf = f;
    pg = gv;
  }
  if (roots.length === 0) return null;
  roots.sort((a, b) => Math.abs(a - cam.fy) - Math.abs(b - cam.fy));
  return roots[0];
}

/** Largest tilt-sensor / lens-centre error (degrees) the pitch solve may absorb. */
export const MAX_PITCH_CORRECTION_DEG = 4;

/** Copy of a camera pitched up by dPhi radians (tilt reduced by the same angle). */
export function withPitchOffset(cam: CameraModel, dPhiRad: number): CameraModel {
  return { ...cam, phiRad: cam.phiRad + dPhiRad, thetaRad: cam.thetaRad - dPhiRad };
}

/**
 * Pitch correction (radians) that makes the head and feet rays, with the typed
 * height, land on one vertical plane - the pitch analogue of solveFocalLength.
 * With the lens ~14 cm above the floor the feet are only 1-2 deg below the
 * horizon, so a sub-degree tilt-sensor error doubles the floor distance; the
 * focal length is the better-known quantity, the pitch is solved instead.
 * Bisection within +/- MAX_PITCH_CORRECTION_DEG; null when there is no root.
 */
export function solvePitchCorrection(
  cam: CameraModel,
  vFeet: number,
  vHead: number,
  heightCm: number,
  view: ViewName = "front",
  opts: { uFeet?: number; uHead?: number; maxDeg?: number } = {},
): number | null {
  if (!(heightCm > 0) || !Number.isFinite(vFeet) || !Number.isFinite(vHead) || !(vFeet > vHead)) return null;
  const uFeet = opts.uFeet ?? cam.cx;
  const uHead = opts.uHead ?? cam.cx;
  const g = (dPhi: number): number => {
    const c = withPitchOffset(cam, dPhi);
    const d = distanceFromFeet(c, vFeet, uFeet);
    if (!(d > 0)) return NaN;
    return geometricHeadHeight(c, view, d, vHead, uHead, heightCm) - heightCm;
  };
  const max = ((opts.maxDeg ?? MAX_PITCH_CORRECTION_DEG) * Math.PI) / 180;
  const N = 160;
  const roots: number[] = [];
  let pa = -max;
  let pg = g(pa);
  for (let i = 1; i <= N; i++) {
    const a = -max + (2 * max * i) / N;
    const gv = g(a);
    if (Number.isFinite(pg) && Number.isFinite(gv) && (pg === 0 || pg * gv < 0)) {
      let lo = pa;
      let hi = a;
      let glo = pg;
      for (let k = 0; k < 60; k++) {
        const m = 0.5 * (lo + hi);
        const gm = g(m);
        if (!Number.isFinite(gm)) break;
        if (glo * gm <= 0) hi = m;
        else {
          lo = m;
          glo = gm;
        }
      }
      roots.push(0.5 * (lo + hi));
    }
    pa = a;
    pg = gv;
  }
  if (roots.length === 0) return null;
  roots.sort((x, y) => Math.abs(x) - Math.abs(y));
  return roots[0];
}
