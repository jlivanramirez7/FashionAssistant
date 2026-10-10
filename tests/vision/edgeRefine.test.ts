import { describe, expect, it } from "vitest";
import { outwardNormal, refineEdges } from "../../src/vision/edgeRefine";

const W = 40, H = 30;

/** Bright person (200) on the left of column `edge`, dark wall (50) right; optional smooth ramp. */
function stepImage(edge: number, ramp = 0): Float32Array {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = ramp > 0 ? 1 / (1 + Math.exp(-(x + 0.5 - edge) / ramp)) : x < edge ? 0 : 1;
      g[y * W + x] = 200 - 150 * t;
    }
  return g;
}

/** Mask = 1 for x < cut. */
function maskUpTo(cut: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < cut; x++) m[y * W + x] = 1;
  return m;
}

function lastInsideCol(m: Uint8Array, y: number): number {
  let last = -1;
  for (let x = 0; x < W; x++) if (m[y * W + x]) last = x;
  return last;
}

describe("outwardNormal", () => {
  it("points from the mask into the background", () => {
    const m = maskUpTo(20);
    expect(outwardNormal(m, W, H, 19, 15)).toEqual([1, 0]);
    expect(outwardNormal(m, W, H, 5, 15)).toBeNull();
  });
});

describe("refineEdges", () => {
  it("grows a mask that stops short of the image edge", () => {
    const out = refineEdges(maskUpTo(18), stepImage(20), W, H); // true last-inside = 19
    for (const y of [5, 15, 25]) expect(lastInsideCol(out, y)).toBe(19);
  });

  it("shrinks a mask that overshoots the edge", () => {
    const out = refineEdges(maskUpTo(23), stepImage(20), W, H);
    for (const y of [5, 15, 25]) expect(lastInsideCol(out, y)).toBe(19);
  });

  it("snaps to the steepest point of a smooth (blurred) gradient", () => {
    const out = refineEdges(maskUpTo(18), stepImage(21, 0.8), W, H); // centre between 20 and 21
    expect(lastInsideCol(out, 15)).toBe(20);
  });

  it("never moves further than the radius", () => {
    const out = refineEdges(maskUpTo(12), stepImage(20), W, H, { radius: 3 });
    expect(lastInsideCol(out, 15)).toBe(11);
  });

  it("leaves the mask alone on a flat image", () => {
    const flat = new Float32Array(W * H).fill(120);
    const m = maskUpTo(18);
    expect(Array.from(refineEdges(m, flat, W, H))).toEqual(Array.from(m));
  });

  it("ignores weak edges below minContrast", () => {
    const g = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = x < 20 ? 105 : 100;
    expect(lastInsideCol(refineEdges(maskUpTo(18), g, W, H), 15)).toBe(17);
  });

  it("refines a vertical edge (horizontal boundary) too", () => {
    const g = new Float32Array(W * H);
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        g[y * W + x] = y < 15 ? 30 : 220;
        if (y < 13) m[y * W + x] = 1;
      }
    const out = refineEdges(m, g, W, H);
    expect(out[14 * W + 20]).toBe(1);
    expect(out[15 * W + 20]).toBe(0);
  });
});
