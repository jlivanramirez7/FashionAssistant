import { describe, expect, it } from "vitest";
import { describeCapabilities, describeSettings } from "../../src/diagnostics/cameraInfo";

describe("camera capability lines", () => {
  it("summarises sizes, aspect, fps, zoom and modes", () => {
    const line = describeCapabilities({
      width: { min: 1, max: 4000 },
      height: { min: 1, max: 3000 },
      aspectRatio: { min: 0.00025, max: 4000 },
      frameRate: { min: 1, max: 30 },
      zoom: { min: 0.7, max: 3, step: 0.1 },
      resizeMode: ["none", "crop-and-scale"],
      facingMode: ["user"],
    });
    expect(line).toBe("width 1-4000, height 1-3000; aspect 0-4000; fps 1-30; zoom 0.7-3 step 0.1; resizeMode none/crop-and-scale; facing user");
  });
  it("says when zoom is not offered and copes with nothing", () => {
    expect(describeCapabilities({ width: { min: 1, max: 1920 } })).toBe("width 1-1920, height ?; zoom not offered");
    expect(describeCapabilities({})).toBe("zoom not offered");
  });
  it("summarises the chosen settings", () => {
    expect(describeSettings({ width: 1920, height: 1080, aspectRatio: 1.7777777, frameRate: 30, resizeMode: "none", facingMode: "user" }))
      .toBe("1920x1080, aspect 1.778, 30fps, resizeMode none, facing user");
  });
});
