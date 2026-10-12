import { describe, expect, it } from "vitest";
import { buildProfile, focalPxFromSpec, lensOffsetCmFromSpec, parseAspectRatio } from "../../src/device/profile";
import { GENERIC_SPEC } from "../../src/device/profiles";
import type { DeviceProfile, DeviceSpec } from "../../src/types";

const spec: DeviceSpec = { model: "Pixel 8", uaModels: ["Pixel 8"], phoneHeightMm: 150.5, frontLensFromTopMm: 7.5, front35mmEqMm: 24 };
const screen = { width: 412, height: 915, devicePixelRatio: 2.625 };
const args = {
  deviceId: "dev-1",
  spec,
  source: "ua-client-hints" as const,
  userAgent: "UA",
  screen,
  captureWidth: 1080,
  captureHeight: 1920,
};

describe("parseAspectRatio", () => {
  it("parses a:b in either order and other separators", () => {
    expect(parseAspectRatio("4:3")).toBeCloseTo(0.75, 12);
    expect(parseAspectRatio("3:4")).toBeCloseTo(0.75, 12);
    expect(parseAspectRatio(" 16 : 9 ")).toBeCloseTo(9 / 16, 12);
    expect(parseAspectRatio("1:1")).toBe(1);
    expect(parseAspectRatio("4/3")).toBeCloseTo(0.75, 12);
    expect(parseAspectRatio("1.85:1")).toBeCloseTo(1 / 1.85, 12);
  });
  it("defaults to 4:3 on garbage", () => {
    for (const bad of ["", "abc", "4:0", "0:3", "4:3:2", "-4:3", undefined, null]) {
      expect(parseAspectRatio(bad)).toBeCloseTo(0.75, 12);
    }
  });
});

describe("focalPxFromSpec", () => {
  const oldFormula = (f35: number, w: number, h: number) => (f35 * Math.hypot(w, h)) / 43.27;
  it("4:3 sensor: f = f35 * sqrt(long^2 + (0.75 long)^2) / 43.27 = f35 * 1.25 long / 43.27", () => {
    expect(focalPxFromSpec(26, 1080, 1920)).toBeCloseTo((26 * 1.25 * 1920) / 43.27, 9);
    expect(focalPxFromSpec(43.27, 3, 4)).toBeCloseTo(5, 9);
  });
  it("defaults to 4:3 and is ~9% above the old video-diagonal formula at 1080x1920", () => {
    expect(focalPxFromSpec(24, 1080, 1920)).toBe(focalPxFromSpec(24, 1080, 1920, "4:3"));
    const ratio = focalPxFromSpec(24, 1080, 1920) / oldFormula(24, 1080, 1920);
    expect(ratio).toBeCloseTo(2400 / Math.hypot(1080, 1920), 9);
    expect(ratio).toBeGreaterThan(1.08);
    expect(ratio).toBeLessThan(1.1);
  });
  it("old behaviour is reachable via the video's own aspect", () => {
    expect(focalPxFromSpec(24, 1080, 1920, "16:9")).toBeCloseTo(oldFormula(24, 1080, 1920), 9);
    expect(focalPxFromSpec(24, 720, 1280, "9:16")).toBeCloseTo(oldFormula(24, 720, 1280), 9);
  });
  it("bad aspect falls back to 4:3", () => {
    expect(focalPxFromSpec(24, 1080, 1920, "nonsense")).toBeCloseTo(focalPxFromSpec(24, 1080, 1920, "4:3"), 9);
  });
  it("is symmetric in width/height and scales linearly", () => {
    expect(focalPxFromSpec(24, 720, 1280)).toBeCloseTo(focalPxFromSpec(24, 1280, 720), 9);
    expect(focalPxFromSpec(24, 1440, 2560)).toBeCloseTo(2 * focalPxFromSpec(24, 720, 1280), 9);
  });
});

describe("lensOffsetCmFromSpec", () => {
  it("(height - lens from top) / 10", () => {
    expect(lensOffsetCmFromSpec(spec)).toBeCloseTo(14.3, 9);
    expect(lensOffsetCmFromSpec(GENERIC_SPEC)).toBe(14);
  });
});

describe("buildProfile", () => {
  it("landscape frames (portrait phone): the long side spans the sensor short side", () => {
    const portrait = buildProfile(args).focalLengthPx;
    const land = buildProfile({ ...args, captureWidth: 1920, captureHeight: 1080 }).focalLengthPx;
    expect(land).toBeCloseTo(portrait / 0.75, 6);
    const land169 = buildProfile({ ...args, spec: { ...spec, frontSensorAspect: "16:9" }, captureWidth: 1920, captureHeight: 1080 });
    expect(land169.focalLengthPx).toBeCloseTo(focalPxFromSpec(24, 1920, 1080, "16:9") * (16 / 9), 6);
  });

  it("uses spec values without a saved record", () => {
    const p = buildProfile(args);
    expect(p).toMatchObject({
      deviceId: "dev-1",
      label: "Pixel 8",
      deviceModelGuess: "Pixel 8",
      modelSource: "ua-client-hints",
      screen,
      phoneHeightMm: 150.5,
      lensOffsetSource: "profile",
      front35mmEqMm: 24,
      focalLengthSource: "spec",
      captureWidth: 1080,
      captureHeight: 1920,
      calibrationScans: 0,
    });
    expect(p.lensOffsetCm).toBeCloseTo(14.3, 9);
    expect(p.focalLengthPx).toBeCloseTo(focalPxFromSpec(24, 1080, 1920), 9);
    expect(p.distortionK1).toBeUndefined();
  });
  it("uses spec.frontSensorAspect", () => {
    const p = buildProfile({ ...args, spec: { ...spec, frontSensorAspect: "16:9" } });
    expect(p.focalLengthPx).toBeCloseTo(focalPxFromSpec(24, 1080, 1920, "16:9"), 9);
    expect(buildProfile(args).focalLengthPx).toBeCloseTo(focalPxFromSpec(24, 1080, 1920, "4:3"), 9);
  });
  it("generic source marks the lens offset generic", () => {
    const p = buildProfile({ ...args, spec: GENERIC_SPEC, source: "generic" });
    expect(p.lensOffsetSource).toBe("generic");
    expect(p.lensOffsetCm).toBe(14);
    expect(p.modelSource).toBe("generic");
  });
  it("saved paper lens offset and height-solve focal length override the spec", () => {
    const saved: Partial<DeviceProfile> = {
      label: "My phone",
      lensOffsetCm: 14.8,
      lensOffsetSource: "paper",
      focalLengthPx: 1500,
      focalLengthSource: "height-solve",
      captureWidth: 1080,
      captureHeight: 1920,
      distortionK1: -0.05,
      calibrationScans: 4,
    };
    const p = buildProfile({ ...args, saved });
    expect(p.lensOffsetCm).toBe(14.8);
    expect(p.lensOffsetSource).toBe("paper");
    expect(p.focalLengthPx).toBe(1500);
    expect(p.focalLengthSource).toBe("height-solve");
    expect(p.distortionK1).toBe(-0.05);
    expect(p.calibrationScans).toBe(4);
    expect(p.label).toBe("My phone");
  });
  it("rescales a saved focal length when the capture size changed", () => {
    const saved: Partial<DeviceProfile> = { focalLengthPx: 1500, focalLengthSource: "paper", captureWidth: 1080, captureHeight: 1920 };
    const p = buildProfile({ ...args, captureWidth: 720, captureHeight: 1280, saved });
    expect(p.focalLengthPx).toBeCloseTo(1000, 9);
    expect(p.focalLengthSource).toBe("paper");
  });
  it("saved spec-sourced values do not override (spec may have been corrected)", () => {
    const saved: Partial<DeviceProfile> = {
      lensOffsetCm: 99,
      lensOffsetSource: "profile",
      focalLengthPx: 9999,
      focalLengthSource: "spec",
      captureWidth: 1080,
      captureHeight: 1920,
    };
    const p = buildProfile({ ...args, saved });
    expect(p.lensOffsetCm).toBeCloseTo(14.3, 9);
    expect(p.focalLengthSource).toBe("spec");
    expect(p.focalLengthPx).toBeCloseTo(focalPxFromSpec(24, 1080, 1920), 9);
  });
  it("ignores invalid saved numbers", () => {
    const saved: Partial<DeviceProfile> = { lensOffsetCm: NaN, lensOffsetSource: "paper", focalLengthPx: 0, focalLengthSource: "height-solve" };
    const p = buildProfile({ ...args, saved });
    expect(p.lensOffsetSource).toBe("profile");
    expect(p.focalLengthSource).toBe("spec");
    expect(buildProfile({ ...args, saved: null }).focalLengthSource).toBe("spec");
  });
});
