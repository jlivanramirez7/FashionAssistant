// One-coefficient radial lens distortion (design doc section 4, "Lens distortion").
// Model in normalized coordinates x = (u - cx) / fx, y = (v - cy) / fy:
//   distorted = undistorted * (1 + k1 * r_u^2),  r_u^2 = x_u^2 + y_u^2.
import type { CameraModel } from "../types";

/** Undistorted normalized coords -> distorted normalized coords. */
export function distortNormalized(k1: number, x: number, y: number): [number, number] {
  if (!k1) return [x, y];
  const s = 1 + k1 * (x * x + y * y);
  return [x * s, y * s];
}

/** Distorted normalized coords -> undistorted (fixed-point iteration). */
export function undistortNormalized(k1: number, xd: number, yd: number): [number, number] {
  if (!k1) return [xd, yd];
  let x = xd;
  let y = yd;
  for (let i = 0; i < 30; i++) {
    const s = 1 + k1 * (x * x + y * y);
    if (!(s > 1e-6) || !Number.isFinite(s)) return [xd, yd];
    const nx = xd / s;
    const ny = yd / s;
    const done = Math.abs(nx - x) < 1e-12 && Math.abs(ny - y) < 1e-12;
    x = nx;
    y = ny;
    if (done) break;
  }
  return [x, y];
}

/** Observed pixel (u, v) -> ideal pinhole pixel. Identity when k1 = 0. */
export function undistort(cam: CameraModel, u: number, v: number): [number, number] {
  if (!cam.k1) return [u, v];
  const [x, y] = undistortNormalized(cam.k1, (u - cam.cx) / cam.fx, (v - cam.cy) / cam.fy);
  return [cam.cx + x * cam.fx, cam.cy + y * cam.fy];
}

/** Ideal pinhole pixel -> observed pixel (inverse of undistort). */
export function distort(cam: CameraModel, u: number, v: number): [number, number] {
  if (!cam.k1) return [u, v];
  const [x, y] = distortNormalized(cam.k1, (u - cam.cx) / cam.fx, (v - cam.cy) / cam.fy);
  return [cam.cx + x * cam.fx, cam.cy + y * cam.fy];
}
