import { describe, expect, it } from "vitest";
import {
  composeMask,
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
