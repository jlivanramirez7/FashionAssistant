// Crop masks -> full-frame PersonMask (design doc section 7). PURE.

import type { PersonMask } from "../types";

/** Person probability for one crop, as returned by the segmenter. */
export interface CropProb {
  /** Crop rectangle in full-frame px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mask resolution (may differ from w x h; it is resampled bilinearly). */
  maskWidth: number;
  maskHeight: number;
  /** maskWidth * maskHeight person probabilities, 0..1. */
  prob: Float32Array;
  /** Health of the raw model output (troubleshooting): highest value / mean class sum. */
  maxProb?: number;
  classSum?: number;
}

/** PURE: highest value (0 for empty). */
export function maxValue(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

/**
 * PURE: mean over sampled pixels of the summed class confidences. A softmax
 * model gives ~1 everywhere; ~0 means the masks read back blank (GPU issue).
 */
export function classSumMean(masks: Float32Array[], step = 37): number {
  if (masks.length === 0 || masks[0].length === 0) return 0;
  let total = 0;
  let n = 0;
  for (let i = 0; i < masks[0].length; i += step) {
    let s = 0;
    for (const m of masks) s += m[i] ?? 0;
    total += s;
    n++;
  }
  return n ? total / n : 0;
}

/** Confidence masks with a mean class sum below this are treated as blank. */
export const BLANK_CLASS_SUM = 0.5;
/** A whole-body mask whose highest value is below this (with a person found) is blank. */
export const BLANK_BODY_MAX = 0.05;

/**
 * Person probability from selfie_multiclass confidence masks
 * (0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others):
 * person = 1 - background. A single mask is taken as the person mask itself.
 */
export function personProbFromConfidence(masks: Float32Array[]): Float32Array {
  if (masks.length === 0) return new Float32Array(0);
  if (masks.length === 1) return Float32Array.from(masks[0]);
  const bg = masks[0];
  const out = new Float32Array(bg.length);
  for (let i = 0; i < bg.length; i++) out[i] = 1 - bg[i];
  return out;
}

/** Same as above from a category mask (value = class index): non-zero => 1. */
export function personProbFromCategory(categories: Uint8Array): Float32Array {
  const out = new Float32Array(categories.length);
  for (let i = 0; i < categories.length; i++) out[i] = categories[i] !== 0 ? 1 : 0;
  return out;
}

/**
 * Full-frame probability: each crop is resampled into its rectangle and
 * overlapping crops are combined with max (a pixel is person if any region
 * crop says so). Pixels outside every crop are 0.
 */
export function composeProbability(crops: CropProb[], width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (const c of crops) {
    if (c.w <= 0 || c.h <= 0 || c.maskWidth <= 0 || c.maskHeight <= 0) continue;
    const sx = c.maskWidth / c.w;
    const sy = c.maskHeight / c.h;
    const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y);
    const x1 = Math.min(width, c.x + c.w), y1 = Math.min(height, c.y + c.h);
    for (let y = y0; y < y1; y++) {
      let my = (y - c.y + 0.5) * sy - 0.5;
      if (my < 0) my = 0;
      if (my > c.maskHeight - 1) my = c.maskHeight - 1;
      const my0 = Math.floor(my), my1 = Math.min(c.maskHeight - 1, my0 + 1), fy = my - my0;
      for (let x = x0; x < x1; x++) {
        let mx = (x - c.x + 0.5) * sx - 0.5;
        if (mx < 0) mx = 0;
        if (mx > c.maskWidth - 1) mx = c.maskWidth - 1;
        const mx0 = Math.floor(mx), mx1 = Math.min(c.maskWidth - 1, mx0 + 1), fx = mx - mx0;
        const p00 = c.prob[my0 * c.maskWidth + mx0], p01 = c.prob[my0 * c.maskWidth + mx1];
        const p10 = c.prob[my1 * c.maskWidth + mx0], p11 = c.prob[my1 * c.maskWidth + mx1];
        const p = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
        const i = y * width + x;
        if (p > out[i]) out[i] = p;
      }
    }
  }
  return out;
}

export function thresholdMask(prob: Float32Array, width: number, height: number, threshold = 0.5): PersonMask {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = prob[i] >= threshold ? 1 : 0;
  return { width, height, data };
}

/** Labels 4-connected components of pixels equal to `value`. Returns labels (0 = none) and sizes (index = label). */
function components(data: Uint8Array, width: number, height: number, value: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(width * height);
  const sizes: number[] = [0];
  const stack = new Int32Array(width * height);
  let next = 1;
  for (let start = 0; start < data.length; start++) {
    if (data[start] !== value || labels[start] !== 0) continue;
    let sp = 0, size = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % width;
      const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const j of nb) {
        if (j < 0 || j >= data.length) continue;
        if (data[j] === value && labels[j] === 0) {
          labels[j] = next;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

/** Drops person blobs smaller than `minFraction` of the largest blob. */
export function keepMainComponents(mask: PersonMask, minFraction = 0.05): PersonMask {
  const { width, height } = mask;
  const { labels, sizes } = components(mask.data, width, height, 1);
  let largest = 0;
  for (const s of sizes) if (s > largest) largest = s;
  const data = new Uint8Array(width * height);
  if (largest === 0) return { width, height, data };
  for (let i = 0; i < data.length; i++) {
    const l = labels[i];
    if (l !== 0 && sizes[l] >= minFraction * largest) data[i] = 1;
  }
  return { width, height, data };
}

/** Fills background holes that do not touch the frame border and are smaller than maxArea px. */
export function fillSmallHoles(mask: PersonMask, maxArea: number): PersonMask {
  const { width, height } = mask;
  const { labels, sizes } = components(mask.data, width, height, 0);
  const touches = new Uint8Array(sizes.length);
  for (let x = 0; x < width; x++) {
    touches[labels[x]] = 1;
    touches[labels[(height - 1) * width + x]] = 1;
  }
  for (let y = 0; y < height; y++) {
    touches[labels[y * width]] = 1;
    touches[labels[y * width + width - 1]] = 1;
  }
  const data = Uint8Array.from(mask.data);
  for (let i = 0; i < data.length; i++) {
    const l = labels[i];
    if (l !== 0 && !touches[l] && sizes[l] <= maxArea) data[i] = 1;
  }
  return { width, height, data };
}

/**
 * A region crop whose mask is "person" along more than this share of its
 * border has filled the whole box (the selfie model gave up on a tight body
 * crop and called the wall "person" too); such crops are dropped.
 */
export const BOX_FILL_LIMIT = 0.8;

/** PURE: share (0..1) of a crop mask's border pixels at or above threshold. */
export function borderFill(c: CropProb, threshold = 0.5): number {
  const { maskWidth: w, maskHeight: h, prob } = c;
  if (w <= 0 || h <= 0) return 0;
  let n = 0;
  let on = 0;
  const visit = (x: number, y: number) => {
    n++;
    if (prob[y * w + x] >= threshold) on++;
  };
  for (let x = 0; x < w; x++) {
    visit(x, 0);
    if (h > 1) visit(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    visit(0, y);
    if (w > 1) visit(w - 1, y);
  }
  return n ? on / n : 0;
}

/** PURE: square binary dilation by r px (prefix sums, O(width * height)). */
export function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const W = width + 1;
  const sum = new Uint32Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x] ? 1 : 0;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      if (s > 0) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * PURE: region detail limited to the whole-body mask. Inside the body mask
 * dilated by r px the sharper region probability may win; outside it only
 * the body probability counts, so a region crop can never paint its box.
 */
export function gateProbability(
  region: Float32Array,
  body: Float32Array,
  width: number,
  height: number,
  r: number,
  threshold = 0.5,
): Float32Array {
  const bin = new Uint8Array(width * height);
  for (let i = 0; i < bin.length; i++) bin[i] = body[i] >= threshold ? 1 : 0;
  const gate = dilate(bin, width, height, r);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = gate[i] ? Math.max(region[i], body[i]) : body[i];
  return out;
}

export interface ComposeOptions {
  threshold?: number;
  /** Blobs smaller than this fraction of the largest are dropped. Default 0.05. */
  minComponentFraction?: number;
  /** Holes up to this fraction of the person area are filled. Default 0.01. */
  maxHoleFraction?: number;
  /** Whole-body mask (full-frame box) from the pose model: limits the region crops. */
  body?: CropProb | null;
  /** How far region detail may extend past the body mask, px. Default max(w, h) / 128. */
  bodyMarginPx?: number;
}

/** Crop probabilities -> cleaned full-frame binary mask (before edge refinement). */
export function composeMask(crops: CropProb[], width: number, height: number, opts: ComposeOptions = {}): PersonMask {
  const t = opts.threshold ?? 0.5;
  const kept = crops.filter((c) => borderFill(c, t) <= BOX_FILL_LIMIT);
  let prob = composeProbability(kept, width, height);
  if (opts.body) {
    const body = composeProbability([opts.body], width, height);
    const r = opts.bodyMarginPx ?? Math.ceil(Math.max(width, height) / 128);
    prob = gateProbability(prob, body, width, height, r, t);
  }
  let mask = thresholdMask(prob, width, height, t);
  mask = keepMainComponents(mask, opts.minComponentFraction ?? 0.05);
  let area = 0;
  for (let i = 0; i < mask.data.length; i++) area += mask.data[i];
  const out = fillSmallHoles(mask, Math.floor(area * (opts.maxHoleFraction ?? 0.01)));
  out.info = { regions: crops.length, regionsDropped: crops.length - kept.length, bodyMask: !!opts.body };
  return out;
}
