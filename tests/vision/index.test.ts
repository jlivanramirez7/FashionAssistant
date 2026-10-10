import { describe, expect, it } from "vitest";
import * as vision from "../../src/vision";
import { toLandmarks } from "../../src/vision/pose";
import { makeBody } from "./synth";

describe("vision index", () => {
  it("imports in Node without loading MediaPipe and exposes the contract API", () => {
    for (const k of ["initVision", "detectPoseLive", "detectPoseHeavy", "segmentPerson", "frameQuality", "checkPose"]) {
      expect(typeof (vision as Record<string, unknown>)[k]).toBe("function");
    }
    expect(vision.MODEL_VERSIONS["tasks-vision"]).toBe("1.1.0");
    expect(vision.checkPose("front", makeBody())).toBe("ok");
  });

  it("toLandmarks copies the first pose", () => {
    expect(toLandmarks([])).toBeNull();
    expect(toLandmarks(undefined)).toBeNull();
    const out = toLandmarks([[{ x: 0.1, y: 0.2, z: 0.3, visibility: 0.9, presence: 1 }]]);
    expect(out).toEqual([{ x: 0.1, y: 0.2, z: 0.3, visibility: 0.9 }]);
  });
});
