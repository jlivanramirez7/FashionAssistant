import { describe, expect, it } from "vitest";
import { cameraConstraintLadder } from "../../src/capture/camera";
import { speechTimeoutMs } from "../../src/capture/voice";

describe("cameraConstraintLadder", () => {
  it("front camera, 1080x1920 ideal then 720x1280", () => {
    const l = cameraConstraintLadder();
    const v0 = l[0].video as MediaTrackConstraints;
    const v1 = l[1].video as MediaTrackConstraints;
    expect(v0.facingMode).toBe("user");
    expect(v0.width).toEqual({ ideal: 1080 });
    expect(v0.height).toEqual({ ideal: 1920 });
    expect(v1.width).toEqual({ ideal: 720 });
    expect(v1.height).toEqual({ ideal: 1280 });
    expect(l.every((c) => c.audio === false)).toBe(true);
  });
});

describe("speechTimeoutMs", () => {
  it("grows with word count", () => {
    expect(speechTimeoutMs("")).toBe(2000);
    expect(speechTimeoutMs("Step back")).toBeGreaterThan(speechTimeoutMs("Stop"));
  });
});
