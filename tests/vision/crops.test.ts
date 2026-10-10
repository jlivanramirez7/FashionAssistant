import { describe, expect, it } from "vitest";
import { LM } from "../../src/types";
import { regionCrops } from "../../src/vision/crops";
import { makeBody } from "./synth";

const W = 1080, H = 1920;

function contains(b: { x: number; y: number; w: number; h: number }, px: number, py: number): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

describe("regionCrops", () => {
  it("falls back to the full frame without landmarks", () => {
    expect(regionCrops(null, W, H)).toEqual([{ name: "full", x: 0, y: 0, w: W, h: H }]);
    expect(regionCrops([], W, H)).toHaveLength(1);
  });

  it("returns the 7 regions with integer boxes inside the frame", () => {
    const crops = regionCrops(makeBody(), W, H);
    expect(crops.map((c) => c.name)).toEqual([
      "head", "neckShoulders", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg",
    ]);
    for (const c of crops) {
      expect(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.w) && Number.isInteger(c.h)).toBe(true);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(W);
      expect(c.y + c.h).toBeLessThanOrEqual(H);
    }
  });

  it("each region contains its landmarks with padding", () => {
    const lm = makeBody();
    const crops = Object.fromEntries(regionCrops(lm, W, H).map((c) => [c.name, c]));
    const p = (i: number) => [lm[i].x * W, lm[i].y * H] as const;
    for (const i of [LM.leftShoulder, LM.leftElbow, LM.leftWrist]) expect(contains(crops.leftArm, ...p(i))).toBe(true);
    for (const i of [LM.rightHip, LM.rightKnee, LM.rightAnkle, LM.rightFootIndex]) expect(contains(crops.rightLeg, ...p(i))).toBe(true);
    for (const i of [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip]) expect(contains(crops.torso, ...p(i))).toBe(true);
    // Head crop reaches above the head top (synthetic top = 0.15).
    expect(crops.head.y).toBeLessThan(0.15 * H);
    // Leg crops are padded sideways by ~0.3 torso length (torso = 0.3 * 0.7 * H).
    const T = 0.3 * 0.7 * H;
    const legX = lm[LM.rightKnee].x * W;
    expect(legX - crops.rightLeg.x).toBeGreaterThanOrEqual(0.3 * T - 1);
  });

  it("clamps boxes for a body partly outside the frame", () => {
    const crops = regionCrops(makeBody({ top: 0.4, frac: 0.8 }), W, H);
    for (const c of crops) expect(c.y + c.h).toBeLessThanOrEqual(H);
    expect(crops.find((c) => c.name === "leftLeg")!.y + crops.find((c) => c.name === "leftLeg")!.h).toBe(H);
  });

  it("falls back when the torso is degenerate", () => {
    const lm = makeBody();
    for (const i of [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip]) lm[i] = { ...lm[i], x: 0.5, y: 0.5 };
    expect(regionCrops(lm, W, H)[0].name).toBe("full");
  });
});
