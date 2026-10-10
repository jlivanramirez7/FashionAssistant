// Edge refinement (design doc section 7, "Segmentation resolution"): snap the
// mask boundary to the strongest image gradient along the outline normal
// within +/-3 px. PURE: operates on plain buffers.

export type GrayBuffer = Uint8Array | Uint8ClampedArray | Float32Array;

export interface RefineOptions {
  /** Max boundary shift in px along an axis-aligned normal (diagonals use round(r / sqrt 2)). Default 3. */
  radius?: number;
  /** Minimum gray-level step (0..255 scale) that counts as an edge. Default 10. */
  minContrast?: number;
  /** Half-size of the window used to estimate the outline normal. Default 2 (5x5). */
  normalWindow?: number;
}

/**
 * Outward normal of the mask at (x, y), quantised to one of 8 directions,
 * or null when it cannot be estimated. Sums the offsets of background pixels
 * in a (2k+1)^2 window.
 */
export function outwardNormal(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  k = 2,
): [number, number] | null {
  let nx = 0, ny = 0;
  for (let dy = -k; dy <= k; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -k; dx <= k; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      if (mask[yy * width + xx] === 0) {
        nx += dx;
        ny += dy;
      }
    }
  }
  if (nx === 0 && ny === 0) return null;
  const q = Math.round(Math.atan2(ny, nx) / (Math.PI / 4));
  const a = (q * Math.PI) / 4;
  return [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
}

/**
 * Returns a refined copy of `mask` (1 = person). For every boundary pixel the
 * gray profile along the outward normal (averaged over 3 parallel lines to
 * suppress noise) is searched for the largest step within +/-radius; the
 * boundary moves there when that step is at least `minContrast`. Ties go to
 * the smallest shift.
 */
export function refineEdges(
  mask: Uint8Array,
  gray: GrayBuffer,
  width: number,
  height: number,
  opts: RefineOptions = {},
): Uint8Array {
  const R = opts.radius ?? 3;
  const minContrast = opts.minContrast ?? 10;
  const k = opts.normalWindow ?? 2;
  const n = width * height;
  const add = new Uint8Array(n);
  const remove = new Uint8Array(n);

  const sample = (x: number, y: number, mx: number, my: number): number => {
    let s = 0, c = 0;
    for (let j = -1; j <= 1; j++) {
      const xx = x + j * mx, yy = y + j * my;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      s += gray[yy * width + xx];
      c++;
    }
    return c > 0 ? s / c : NaN;
  };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      if (mask[i - 1] !== 0 && mask[i + 1] !== 0 && mask[i - width] !== 0 && mask[i + width] !== 0) continue;
      const nrm = outwardNormal(mask, width, height, x, y, k);
      if (!nrm) continue;
      const [dx, dy] = nrm;
      const r = dx !== 0 && dy !== 0 ? Math.round(R / Math.SQRT2) : R;
      const mx = -dy, my = dx; // tangent, for averaging across the edge direction
      // Profile s(t) for t in [-r, r+1].
      const prof: number[] = [];
      for (let t = -r; t <= r + 1; t++) prof.push(sample(x + t * dx, y + t * dy, mx, my));
      let best = 0, bestD = -1;
      for (let t = -r; t <= r; t++) {
        const a = prof[t + r], b = prof[t + r + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const d = Math.abs(b - a);
        if (d > bestD || (d === bestD && Math.abs(t) < Math.abs(best))) {
          bestD = d;
          best = t;
        }
      }
      if (best === 0 || bestD < minContrast) continue;
      if (best > 0) {
        for (let s = 1; s <= best; s++) {
          const xx = x + s * dx, yy = y + s * dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) add[yy * width + xx] = 1;
        }
      } else {
        for (let s = best + 1; s <= 0; s++) {
          const xx = x + s * dx, yy = y + s * dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) remove[yy * width + xx] = 1;
        }
      }
    }
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (add[i] && !remove[i]) out[i] = 1;
    else if (remove[i] && !add[i]) out[i] = 0;
    else out[i] = mask[i] ? 1 : 0;
  }
  return out;
}
