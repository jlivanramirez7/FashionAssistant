import { describe, expect, it } from "vitest";
import { downsampleProb } from "../../src/vision/pose";

describe("downsampleProb (stored whole-body masks)", () => {
  it("keeps small masks as they are", () => {
    const p = Float32Array.from([0, 1, 1, 0]);
    expect(downsampleProb(p, 2, 2, 512)).toEqual({ w: 2, h: 2, prob: p });
  });
  it("shrinks to the long-side limit, nearest sampling, aspect kept", () => {
    const w = 1920, h = 1080;
    const p = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 960; x < w; x++) p[y * w + x] = 1; // right half
    const d = downsampleProb(p, w, h, 512);
    expect([d.w, d.h]).toEqual([512, 288]);
    expect(d.prob[100 * 512 + 100]).toBe(0);
    expect(d.prob[100 * 512 + 400]).toBe(1);
  });
});
