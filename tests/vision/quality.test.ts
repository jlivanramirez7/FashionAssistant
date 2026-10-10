import { describe, expect, it } from "vitest";
import {
  BLUR_THRESHOLD,
  frameQualityFrom,
  laplacianVariance,
  landmarksInFrame,
  rgbaToGray,
  sharpnessScore,
} from "../../src/vision/quality";
import { jitter, makeBody } from "./synth";

const W = 180, H = 320;

/** Checkerboard texture (8 px squares) as gray. */
function checker(): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? 220 : 40;
  return g;
}

function boxBlur(src: Float32Array, r: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
          s += src[yy * W + xx];
          n++;
        }
      out[y * W + x] = s / n;
    }
  return out;
}

function toRgba(g: Float32Array): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < g.length; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i];
    d[i * 4 + 3] = 255;
  }
  return d;
}

describe("gray + Laplacian", () => {
  it("converts RGBA to luma", () => {
    const g = rgbaToGray(Uint8ClampedArray.from([255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 255]), 3, 1);
    expect(Array.from(g)).toEqual([255, 76, 0]);
  });
  it("is 0 on a flat image and on a linear ramp", () => {
    expect(laplacianVariance(new Float32Array(W * H).fill(90), W, H)).toBe(0);
    const ramp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ramp[y * W + x] = x;
    expect(laplacianVariance(ramp, W, H)).toBeCloseTo(0, 6);
  });
  it("is much larger for a sharp image than for its blurred copy", () => {
    const sharp = checker();
    const blurred = boxBlur(boxBlur(sharp, 4), 4);
    const vs = laplacianVariance(sharp, W, H);
    const vb = laplacianVariance(blurred, W, H);
    expect(vs).toBeGreaterThan(20 * vb);
    expect(sharpnessScore(vs)).toBeGreaterThan(BLUR_THRESHOLD);
    expect(sharpnessScore(vb)).toBeLessThan(BLUR_THRESHOLD);
  });
  it("restricts to a ROI", () => {
    const g = new Float32Array(W * H).fill(100);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) g[y * W + x] = (x + y) % 2 ? 0 : 255;
    expect(laplacianVariance(g, W, H, { x: 100, y: 100, w: 50, h: 50 })).toBe(0);
    expect(laplacianVariance(g, W, H, { x: 0, y: 0, w: 50, h: 50 })).toBeGreaterThan(1000);
  });
});

describe("landmarksInFrame", () => {
  it("accepts a centred body and rejects one cut off", () => {
    expect(landmarksInFrame(makeBody())).toBe(true);
    expect(landmarksInFrame(jitter(makeBody(), 0.3, 0))).toBe(false);
    expect(landmarksInFrame(null)).toBe(false);
  });
});

describe("frameQualityFrom", () => {
  const lm = makeBody();
  it("sharp, in frame => good score, no reason", () => {
    const q = frameQualityFrom({ data: toRgba(checker()), width: W, height: H }, lm);
    expect(q.inFrame).toBe(true);
    expect(q.reason).toBeUndefined();
    expect(q.score).toBeGreaterThan(0.6);
  });
  it("blurred => blurry", () => {
    const q = frameQualityFrom({ data: toRgba(boxBlur(boxBlur(checker(), 4), 4)), width: W, height: H }, lm);
    expect(q.reason).toBe("blurry");
  });
  it("out of frame => out-of-frame with a halved score", () => {
    const q = frameQualityFrom({ data: toRgba(checker()), width: W, height: H }, jitter(lm, 0, 0.12));
    expect(q.inFrame).toBe(false);
    expect(q.reason).toBe("out-of-frame");
    expect(q.score).toBeCloseTo(q.sharpness * 0.5);
  });
  it("no landmarks => no-person", () => {
    expect(frameQualityFrom({ data: toRgba(checker()), width: W, height: H }, null)).toEqual({
      sharpness: 0, inFrame: false, score: 0, reason: "no-person",
    });
  });
});
