import { describe, expect, it } from "vitest";
import {
  BOX_FILL_LIMIT,
  borderFill,
  composeMask,
  dilate,
  gateProbability,
  composeProbability,
  fillSmallHoles,
  keepMainComponents,
  personProbFromCategory,
  personProbFromConfidence,
  thresholdMask,
  type CropProb,
} from "../../src/vision/compose";

function filled(w: number, h: number, v: number): Float32Array {
  return new Float32Array(w * h).fill(v);
}

describe("person probability", () => {
  it("is 1 - background for multiclass masks", () => {
    const bg = Float32Array.from([1, 0.2, 0]);
    const hair = Float32Array.from([0, 0.8, 0]);
    expect(Array.from(personProbFromConfidence([bg, hair]))).toEqual([0, 1 - 0.2, 1].map((v) => Math.fround(v)));
  });
  it("single mask is taken as-is; categories != 0 are person", () => {
    expect(Array.from(personProbFromConfidence([Float32Array.from([0.3])]))).toEqual([Math.fround(0.3)]);
    expect(Array.from(personProbFromCategory(Uint8Array.from([0, 1, 4, 5])))).toEqual([0, 1, 1, 1]);
  });
});

describe("composeProbability", () => {
  it("places a crop at its rectangle and leaves the rest 0", () => {
    const crop: CropProb = { x: 2, y: 3, w: 4, h: 2, maskWidth: 4, maskHeight: 2, prob: filled(4, 2, 1) };
    const p = composeProbability([crop], 10, 8);
    let ones = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
      const inside = x >= 2 && x < 6 && y >= 3 && y < 5;
      expect(p[y * 10 + x]).toBe(inside ? 1 : 0);
      if (inside) ones++;
    }
    expect(ones).toBe(8);
  });

  it("resamples a low-res crop mask (left half person)", () => {
    // 2x2 mask: left column 1, right 0, stretched over a 20x20 crop.
    const crop: CropProb = { x: 0, y: 0, w: 20, h: 20, maskWidth: 2, maskHeight: 2, prob: Float32Array.from([1, 0, 1, 0]) };
    const m = thresholdMask(composeProbability([crop], 20, 20), 20, 20);
    // Bilinear between mask centres (x = 5 and x = 15): 0.5 crossing at x = 10.
    expect(m.data[5 * 20 + 9]).toBe(1);
    expect(m.data[5 * 20 + 10]).toBe(0);
  });

  it("combines overlapping crops with max", () => {
    const a: CropProb = { x: 0, y: 0, w: 4, h: 4, maskWidth: 4, maskHeight: 4, prob: filled(4, 4, 0.2) };
    const b: CropProb = { x: 2, y: 0, w: 4, h: 4, maskWidth: 4, maskHeight: 4, prob: filled(4, 4, 0.9) };
    const p = composeProbability([a, b], 8, 4);
    expect(p[0]).toBeCloseTo(0.2);
    expect(p[3]).toBeCloseTo(0.9);
    expect(p[7]).toBe(0);
  });

  it("clips crops that extend outside the frame", () => {
    const c: CropProb = { x: -2, y: -2, w: 4, h: 4, maskWidth: 4, maskHeight: 4, prob: filled(4, 4, 1) };
    const p = composeProbability([c], 4, 4);
    expect(p[0]).toBe(1);
    expect(p[1]).toBe(1);
    expect(p[2]).toBe(0);
  });
});

describe("mask cleanup", () => {
  it("drops small blobs and keeps the main body", () => {
    const w = 20, h = 20;
    const data = new Uint8Array(w * h);
    for (let y = 2; y < 18; y++) for (let x = 5; x < 15; x++) data[y * w + x] = 1; // 160 px
    data[0] = 1; // speck
    const out = keepMainComponents({ width: w, height: h, data });
    expect(out.data[0]).toBe(0);
    expect(out.data[10 * w + 10]).toBe(1);
  });

  it("fills small enclosed holes but not gaps open to the border", () => {
    const w = 20, h = 20;
    const data = new Uint8Array(w * h);
    for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) data[y * w + x] = 1;
    data[8 * w + 8] = 0; // hole
    for (let y = 10; y < 20; y++) data[y * w + 10] = 0; // gap reaching the bottom edge
    const out = fillSmallHoles({ width: w, height: h, data }, 5);
    expect(out.data[8 * w + 8]).toBe(1);
    expect(out.data[15 * w + 10]).toBe(0);
  });

  it("composeMask runs end to end", () => {
    const crop: CropProb = { x: 0, y: 0, w: 10, h: 10, maskWidth: 10, maskHeight: 10, prob: new Float32Array(100) };
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) crop.prob[y * 10 + x] = 0.9;
    crop.prob[5 * 10 + 5] = 0.1; // one-pixel hole
    const m = composeMask([crop], 10, 10, { maxHoleFraction: 0.05 });
    expect(m.width).toBe(10);
    expect(m.data.reduce((a, b) => a + b, 0)).toBe(36);
  });
});

describe("whole-body gating (crops that fill their box)", () => {
  const W = 40;
  const H = 40;
  /** A crop whose mask says "person" everywhere: the failure seen on real phones. */
  const filled = (x: number, y: number, w: number, h: number): CropProb => ({
    x, y, w, h, maskWidth: 8, maskHeight: 8, prob: new Float32Array(64).fill(1),
  });
  /** Body: a 10 px wide vertical bar in the middle of the frame. */
  const bodyProb = new Float32Array(W * H);
  for (let y = 5; y < 35; y++) for (let x = 15; x < 25; x++) bodyProb[y * W + x] = 1;
  const body: CropProb = { x: 0, y: 0, w: W, h: H, maskWidth: W, maskHeight: H, prob: bodyProb };

  it("borderFill measures the share of person pixels on the crop border", () => {
    expect(borderFill(filled(0, 0, 10, 10))).toBe(1);
    const ring = new Float32Array(16);
    ring[5] = ring[6] = ring[9] = ring[10] = 1; // centre 2x2 only
    expect(borderFill({ x: 0, y: 0, w: 4, h: 4, maskWidth: 4, maskHeight: 4, prob: ring })).toBe(0);
    expect(BOX_FILL_LIMIT).toBeLessThan(1);
  });

  it("dilate grows a pixel into a (2r+1) square, clipped to the frame", () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    expect([...dilate(m, 5, 5, 1)].reduce((a, b) => a + b, 0)).toBe(9);
    expect([...dilate(m, 5, 5, 5)].every((v) => v === 1)).toBe(true);
    expect([...dilate(new Uint8Array(25), 5, 5, 2)].every((v) => v === 0)).toBe(true);
  });

  it("gateProbability keeps region detail only near the body", () => {
    const region = new Float32Array(W * H).fill(1);
    const out = gateProbability(region, bodyProb, W, H, 2);
    expect(out[20 * W + 20]).toBe(1); // on the body
    expect(out[20 * W + 13]).toBe(1); // within 2 px of it
    expect(out[20 * W + 5]).toBe(0); // far away: body prob only
  });

  it("a box-filling region crop no longer widens the mask", () => {
    const crop = filled(5, 5, 30, 30); // wall included
    const naive = composeMask([crop], W, H);
    expect(naive.data.reduce((a, b) => a + b, 0)).toBe(0); // dropped: it filled its box
    expect(naive.info).toEqual({ regions: 1, regionsDropped: 1, bodyMask: false });
    const gated = composeMask([crop], W, H, { body, bodyMarginPx: 1 });
    const widthAt20 = [...gated.data.slice(20 * W, 21 * W)].reduce((a, b) => a + b, 0);
    expect(widthAt20).toBe(10); // the body bar, not the 30 px crop
    expect(gated.info).toEqual({ regions: 1, regionsDropped: 1, bodyMask: true });
  });

  it("an honest region crop still adds detail inside the body margin", () => {
    const p = new Float32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 2; x < 6; x++) p[y * 8 + x] = 1; // person in the middle of the crop
    const crop: CropProb = { x: 12, y: 10, w: 16, h: 16, maskWidth: 8, maskHeight: 8, prob: p };
    const m = composeMask([crop], W, H, { body, bodyMarginPx: 2 });
    expect(m.info?.regionsDropped).toBe(0);
    expect(m.data[20 * W + 20]).toBe(1);
  });
});
