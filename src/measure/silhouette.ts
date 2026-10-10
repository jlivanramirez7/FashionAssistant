// Person-mask queries (design doc section 7).
// Coordinates are continuous pixel coords: pixel (x, y) covers [x, x+1) x [y, y+1).
import type { PersonMask } from "../types";

export function maskAt(mask: PersonMask, u: number, v: number): boolean {
  const x = Math.floor(u);
  const y = Math.floor(v);
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.data[y * mask.width + x] !== 0;
}

/**
 * Horizontal run of mask pixels in row floor(v) that contains column nearU, or the
 * run nearest to it. u0 = left edge (first pixel index), u1 = right edge (last pixel
 * index + 1), so the width in pixels is u1 - u0. null if the row is empty/out of range.
 */
export function spanAtRow(mask: PersonMask, v: number, nearU: number): { u0: number; u1: number } | null {
  const { width, height, data } = mask;
  const y = Math.floor(v);
  if (!Number.isFinite(v) || y < 0 || y >= height || width <= 0) return null;
  const row = y * width;
  let x = Math.floor(Number.isFinite(nearU) ? nearU : width / 2);
  x = Math.min(width - 1, Math.max(0, x));
  if (!data[row + x]) {
    // nearest set pixel, searching both directions
    let found = -1;
    for (let k = 1; k < width; k++) {
      const l = x - k;
      const r = x + k;
      if (l < 0 && r >= width) break;
      if (l >= 0 && data[row + l]) {
        found = l;
        break;
      }
      if (r < width && data[row + r]) {
        found = r;
        break;
      }
    }
    if (found < 0) return null;
    x = found;
  }
  let a = x;
  while (a > 0 && data[row + a - 1]) a--;
  let b = x;
  while (b < width - 1 && data[row + b + 1]) b++;
  return { u0: a, u1: b + 1 };
}

/**
 * Chord of the mask through (u, v) along direction (du, dv) (any length): walks both
 * ways in 0.25 px steps until it leaves the mask. Returns the two boundary points, or
 * null if (u, v) is outside the mask or the chord is longer than maxLenPx.
 */
export function chordThrough(
  mask: PersonMask,
  u: number,
  v: number,
  du: number,
  dv: number,
  maxLenPx = Infinity,
): { a: [number, number]; b: [number, number] } | null {
  const n = Math.hypot(du, dv);
  if (!(n > 0) || !maskAt(mask, u, v)) return null;
  const ex = du / n;
  const ey = dv / n;
  const step = 0.25;
  const limit = Math.min(maxLenPx, mask.width + mask.height);
  const walk = (sgn: number): number | null => {
    let t = 0;
    while (t <= limit) {
      const nt = t + step;
      if (!maskAt(mask, u + sgn * ex * nt, v + sgn * ey * nt)) return t + step / 2;
      t = nt;
    }
    return null;
  };
  const tp = walk(1);
  const tm = walk(-1);
  if (tp === null || tm === null || tp + tm > maxLenPx) return null;
  return { a: [u - ex * tm, v - ey * tm], b: [u + ex * tp, v + ey * tp] };
}

/** Top-most row index containing a mask pixel within columns [uMin, uMax), or null. */
export function topRow(mask: PersonMask, uMin = 0, uMax = mask.width): number | null {
  const a = Math.max(0, Math.floor(uMin));
  const b = Math.min(mask.width, Math.ceil(uMax));
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width;
    for (let x = a; x < b; x++) if (mask.data[row + x]) return y;
  }
  return null;
}

/** Bottom-most row index containing a mask pixel within columns [uMin, uMax), or null. */
export function bottomRow(mask: PersonMask, uMin = 0, uMax = mask.width): number | null {
  const a = Math.max(0, Math.floor(uMin));
  const b = Math.min(mask.width, Math.ceil(uMax));
  for (let y = mask.height - 1; y >= 0; y--) {
    const row = y * mask.width;
    for (let x = a; x < b; x++) if (mask.data[row + x]) return y;
  }
  return null;
}
