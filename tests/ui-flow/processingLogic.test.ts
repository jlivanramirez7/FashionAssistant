import { describe, expect, it } from "vitest";
import type { CapturedFrame, DeviceProfile, PipelineResult } from "../../src/types";
import {
  buildScanDoc,
  MAX_RETAKES_PER_STEP,
  overallProgress,
  planRetakes,
  updatedProfile,
} from "../../src/ui/processingLogic";

const profile: DeviceProfile = {
  deviceId: "dev1",
  label: "Android Chrome",
  deviceModelGuess: "Pixel 8",
  modelSource: "ua-client-hints",
  screen: { width: 412, height: 915, devicePixelRatio: 2.6 },
  lensOffsetCm: 14,
  lensOffsetSource: "profile",
  front35mmEqMm: 20,
  focalLengthPx: 1500,
  focalLengthSource: "spec",
  captureWidth: 1080,
  captureHeight: 1920,
  calibrationScans: 0,
};

const result: PipelineResult = {
  measurements: { chest: { valueCm: 98, uncertaintyCm: 2, confidence: 0.8 } },
  rawMeasurements: { chest: 97 },
  diagnostics: {
    videoWidth: 1080,
    videoHeight: 1920,
    focalLengthPxSpec: 1500,
    lensOffsetCm: 14,
    lensHeightCm: 13,
    tiltDeg: 75,
    rollDeg: 0,
    distanceM: { front: 2.5 },
    scaleAgreementPct: 1,
    qualityScores: { front: 0.9 },
    processingMs: 8000,
    modelVersions: { pose: "x" },
  },
  retakeViews: [],
};

const frame = {} as CapturedFrame;

describe("overallProgress", () => {
  it("maps stage + fraction to 0..1", () => {
    expect(overallProgress("pose", 0)).toBe(0);
    expect(overallProgress("measure", 1)).toBe(1);
    expect(overallProgress("front", 0.5)).toBeCloseTo(2.5 / 6);
    expect(overallProgress("side", NaN)).toBeCloseTo(3 / 6);
    expect(overallProgress("pose", 7)).toBeCloseTo(1 / 6);
  });
});

describe("planRetakes", () => {
  it("retakes flagged steps under the limit, once each", () => {
    const p = planRetakes(
      [
        { view: "side", reason: "blurry" },
        { view: "side", reason: "out-of-frame" },
      ],
      {},
    );
    expect(p).toEqual({ retake: [{ view: "side", reason: "blurry" }], unresolved: [] });
  });
  it("gives up on a step after the limit (scan is then partial)", () => {
    const p = planRetakes(
      [
        { view: "front", reason: "blurry" },
        { view: "back", reason: "distance-mismatch" },
      ],
      { front: MAX_RETAKES_PER_STEP, back: 1 },
    );
    expect(p.retake).toEqual([{ view: "back", reason: "distance-mismatch" }]);
    expect(p.unresolved).toEqual(["front"]);
  });
});

describe("buildScanDoc", () => {
  it("fills the section 11 fields", () => {
    const doc = buildScanDoc({
      session: {
        inputs: { heightCm: 178, bodyType: "male", subjectLabel: "me" },
        profile,
        retakes: [{ step: "side", reason: "blurry" }],
        unresolved: [],
        captures: { front: [frame], side: [frame], back: [frame] },
      },
      result,
      deviceId: "dev1",
      appVersion: "0.1.0",
      userAgent: "UA",
      now: 123,
    });
    expect(doc).toMatchObject({
      createdAt: 123,
      status: "complete",
      heightCm: 178,
      bodyType: "male",
      subjectLabel: "me",
      scaleSource: "height+floor",
      deviceId: "dev1",
      appVersion: "0.1.0",
      viewsCaptured: ["front", "side", "back"],
      measurements: result.measurements,
      rawMeasurements: result.rawMeasurements,
    });
    expect(doc.diagnostics).toMatchObject({
      userAgent: "UA",
      deviceModelGuess: "Pixel 8",
      modelSource: "ua-client-hints",
      retakes: [{ step: "side", reason: "blurry" }],
      processingMs: 8000,
    });
  });
  it("is partial when a step stayed bad", () => {
    const doc = buildScanDoc({
      session: {
        inputs: { heightCm: 170, bodyType: "female", subjectLabel: "Person 3" },
        profile,
        retakes: [],
        unresolved: ["back"],
        captures: { front: [frame], side: [frame], back: [frame] },
      },
      result,
      deviceId: "d",
      appVersion: "0.1.0",
      userAgent: "UA",
      now: 1,
    });
    expect(doc.status).toBe("partial");
    expect(doc.subjectLabel).toBe("Person 3");
  });
});

describe("updatedProfile", () => {
  it("keeps the profile when nothing was solved", () => {
    expect(updatedProfile(profile, undefined)).toBe(profile);
    expect(updatedProfile(profile, NaN)).toBe(profile);
  });
  it("stores the height-solved focal length and counts the scan", () => {
    expect(updatedProfile(profile, 1600)).toMatchObject({
      focalLengthPx: 1600,
      focalLengthSource: "height-solve",
      calibrationScans: 1,
    });
  });
  it("does not downgrade a paper calibration's source", () => {
    expect(updatedProfile({ ...profile, focalLengthSource: "paper" }, 1600).focalLengthSource).toBe("paper");
  });
});
