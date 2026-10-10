import { describe, expect, it } from "vitest";
import { LM } from "../../src/types";
import {
  armAngleDeg,
  bodyHeightFraction,
  checkPose,
  maxMotion,
  shoulderWidthRatio,
} from "../../src/vision/poseCheck";
import { jitter, makeBody } from "./synth";

describe("pose metrics", () => {
  it("measures arm angle with aspect correction", () => {
    const b = makeBody({ armDeg: 45 });
    expect(armAngleDeg(b, "left")).toBeCloseTo(45, 5);
    expect(armAngleDeg(b, "right")).toBeCloseTo(45, 5);
    expect(armAngleDeg(makeBody({ armDeg: 10 }), "left")).toBeCloseTo(10, 5);
  });
  it("shoulder ratio collapses in the side view", () => {
    expect(shoulderWidthRatio(makeBody({ view: "front" }))).toBeGreaterThan(0.6);
    expect(shoulderWidthRatio(makeBody({ view: "side" }))).toBeLessThan(0.2);
  });
  it("body fraction ~ frac", () => {
    expect(bodyHeightFraction(makeBody({ frac: 0.7 }))).toBeCloseTo(0.7 * 0.966, 2);
  });
  it("motion is zero for identical frames", () => {
    const b = makeBody();
    expect(maxMotion(b, [b, b])).toBe(0);
    expect(maxMotion(b, [jitter(b, 0, 0.02)])).toBeCloseTo(0.02, 6);
  });
});

describe("checkPose", () => {
  it("ok for a good pose in each view", () => {
    expect(checkPose("front", makeBody({ view: "front" }))).toBe("ok");
    expect(checkPose("side", makeBody({ view: "side" }))).toBe("ok");
    expect(checkPose("back", makeBody({ view: "back" }))).toBe("ok");
  });

  it("no-person", () => {
    expect(checkPose("front", null)).toBe("no-person");
    expect(checkPose("front", makeBody().slice(0, 20))).toBe("no-person");
    expect(checkPose("front", makeBody({ bodyVis: 0.1 }))).toBe("no-person");
  });

  it("step-back when too big or feet low", () => {
    expect(checkPose("front", makeBody({ frac: 0.9, top: 0.05 }))).toBe("step-back");
    expect(checkPose("front", makeBody({ frac: 0.7, top: 0.25 }))).toBe("step-back"); // feet at ~0.93
    expect(checkPose("front", makeBody({ frac: 0.7, top: -0.02 }))).toBe("step-back"); // head cut off
  });

  it("move-closer when small", () => {
    expect(checkPose("front", makeBody({ frac: 0.45, top: 0.3 }))).toBe("move-closer");
  });

  it("center when off to one side", () => {
    expect(checkPose("front", makeBody({ cx: 0.3, armDeg: 35 }))).toBe("center");
    expect(checkPose("front", makeBody({ cx: 0.65, armDeg: 35 }))).toBe("center");
  });

  it("step-back when centred but the arms leave the frame", () => {
    expect(checkPose("front", makeBody({ frac: 0.8, top: 0.08, armDeg: 55 }))).toBe("step-back");
  });

  it("front: face-phone when turned away or sideways", () => {
    expect(checkPose("front", makeBody({ view: "back" }))).toBe("face-phone");
    expect(checkPose("front", makeBody({ view: "side" }))).toBe("face-phone");
  });

  it("front/back: arms-out and arms-down", () => {
    expect(checkPose("front", makeBody({ armDeg: 10 }))).toBe("arms-out");
    expect(checkPose("front", makeBody({ leftArmDeg: 45, rightArmDeg: 15 }))).toBe("arms-out");
    expect(checkPose("front", makeBody({ armDeg: 75 }))).toBe("arms-down");
    expect(checkPose("back", makeBody({ view: "back", armDeg: 10 }))).toBe("arms-out");
    expect(checkPose("back", makeBody({ view: "back", armDeg: 75 }))).toBe("arms-down");
  });

  it("side: turn-side when facing or showing the wrong shoulder", () => {
    expect(checkPose("side", makeBody({ view: "front" }))).toBe("turn-side");
    expect(checkPose("side", makeBody({ view: "side", wrongSide: true }))).toBe("turn-side");
  });

  it("side: uses z when the nose offset is ambiguous", () => {
    const b = makeBody({ view: "side" });
    const mid = (b[LM.leftShoulder].x + b[LM.rightShoulder].x) / 2;
    b[LM.nose] = { ...b[LM.nose], x: mid };
    expect(checkPose("side", b)).toBe("ok");
    const w = makeBody({ view: "side", wrongSide: true });
    const mid2 = (w[LM.leftShoulder].x + w[LM.rightShoulder].x) / 2;
    w[LM.nose] = { ...w[LM.nose], x: mid2 };
    expect(checkPose("side", w)).toBe("turn-side");
  });

  it("side: arms-down when arms are raised", () => {
    expect(checkPose("side", makeBody({ view: "side", armDeg: 45 }))).toBe("arms-down");
  });

  it("back: turn-back when the face is visible or sideways", () => {
    expect(checkPose("back", makeBody({ view: "front" }))).toBe("turn-back");
    expect(checkPose("back", makeBody({ view: "side" }))).toBe("turn-back");
    expect(checkPose("back", makeBody({ view: "back", faceVis: 0.9 }))).toBe("turn-back");
  });

  it("hold-still from history", () => {
    const b = makeBody();
    const still = [jitter(b, 0.002, 0.001), jitter(b, -0.001, 0.002), b];
    expect(checkPose("front", b, still)).toBe("ok");
    const moving = [jitter(b, 0.03, 0), jitter(b, 0.015, 0)];
    expect(checkPose("front", b, moving)).toBe("hold-still");
    expect(checkPose("front", b, [])).toBe("ok");
  });

  it("respects a landscape aspect option", () => {
    const b = makeBody({ aspect: 16 / 9, frac: 0.7 });
    expect(armAngleDeg(b, "left", 16 / 9)).toBeCloseTo(45, 5);
    expect(checkPose("front", b, undefined, { aspect: 16 / 9 })).toBe("ok");
  });
});
