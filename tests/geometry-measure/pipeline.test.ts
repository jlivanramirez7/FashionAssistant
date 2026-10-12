import { describe, expect, it } from "vitest";
import type { CapturedFrame, Landmark, PersonMask, ProgressStage, QualityScore, ViewCapture, ViewName } from "../../src/types";
import { feetPoint, headPoint, PITCH_TOLERANCE_DEG, runPipeline, toPixelLandmarks, type VisionApi } from "../../src/pipeline/runPipeline";
import { Body, DEFAULT_CAM, normalized, profileFor, truth } from "./synthetic";
import { sceneFrames, DIST } from "./scene";

interface FakeImage {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function setup(opts: { H?: number; noPerson?: ViewName[]; reason?: Partial<Record<ViewName, QualityScore["reason"]>> } = {}) {
  const H = opts.H ?? 175;
  const body = new Body(H);
  const frames = sceneFrames(body, DEFAULT_CAM, 3, 0.3, 11);
  const table = new Map<number, { lms: Landmark[] | null; mask: PersonMask; view: ViewName }>();
  const captures: ViewCapture[] = [];
  let id = 0;
  for (const view of ["front", "side", "back"] as ViewName[]) {
    const cf: CapturedFrame[] = [];
    for (const f of frames.filter((x) => x.view === view)) {
      const img: FakeImage = { id: ++id, width: DEFAULT_CAM.width, height: DEFAULT_CAM.height, data: new Uint8ClampedArray(4) };
      const person = !opts.noPerson?.includes(view);
      table.set(img.id, { lms: person ? normalized(f.landmarksPx, DEFAULT_CAM) : null, mask: f.mask, view });
      cf.push({
        view,
        timestampMs: id * 100,
        image: img as unknown as ImageData,
        width: DEFAULT_CAM.width,
        height: DEFAULT_CAM.height,
        orientation: { tiltDeg: DEFAULT_CAM.thetaDeg, rollDeg: 0 },
      });
    }
    captures.push({ view, frames: cf });
  }
  const calls = { pose: 0, seg: 0, quality: 0 };
  const vision: VisionApi = {
    detectPoseHeavy: async (image) => {
      calls.pose++;
      return table.get((image as unknown as FakeImage).id)!.lms;
    },
    segmentPerson: async (image) => {
      calls.seg++;
      return table.get((image as unknown as FakeImage).id)!.mask;
    },
    frameQuality: (image) => {
      calls.quality++;
      const v = table.get((image as unknown as FakeImage).id)!.view;
      const reason = opts.reason?.[v];
      return { sharpness: reason ? 0.1 : 0.9, inFrame: true, score: reason ? 0.2 : 0.9, ...(reason ? { reason } : {}) };
    },
    modelVersions: { pose: "heavy-test" },
  };
  return { body, captures, vision, calls };
}

const inputs = (heightCm: number) => ({ heightCm, bodyType: "unspecified" as const, subjectLabel: "me" });

describe("runPipeline (fake vision)", () => {
  it("measures a synthetic scan end to end with no retakes", async () => {
    const { body, captures, vision, calls } = setup();
    const stages = new Set<ProgressStage>();
    const r = await runPipeline({
      captures,
      profile: profileFor(DEFAULT_CAM),
      inputs: inputs(175),
      factors: null,
      vision,
      onProgress: (s, f) => {
        stages.add(s);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      },
    });
    expect(calls.pose).toBe(9);
    expect(calls.seg).toBe(9);
    expect(r.retakeViews).toEqual([]);
    expect(r.solvedFocalLengthPx).toBeUndefined(); // spec value within 5%
    expect(Math.abs(r.diagnostics.focalLengthPxSolved! / DEFAULT_CAM.f - 1)).toBeLessThan(0.01);
    expect(r.diagnostics.focalLengthPxSpec).toBe(DEFAULT_CAM.f);
    expect(r.diagnostics.distanceM.front!).toBeCloseTo(DIST.front / 100, 1);
    expect(r.diagnostics.distanceM.side!).toBeCloseTo(DIST.side / 100, 1);
    expect(r.diagnostics.scaleAgreementPct).toBeLessThan(1);
    expect(r.diagnostics.qualityScores).toEqual({ front: 0.9, side: 0.9, back: 0.9 });
    expect(r.diagnostics.modelVersions).toEqual({ pose: "heavy-test" });
    expect(r.diagnostics.tiltDeg).toBe(75);
    expect(r.diagnostics.lensHeightCm).toBeCloseTo(14 * Math.sin((75 * Math.PI) / 180), 9);
    for (const s of ["pose", "outline", "front", "side", "back", "measure"] as ProgressStage[]) expect(stages.has(s)).toBe(true);
    const t = truth(body);
    for (const k of ["chest", "naturalWaist", "hips", "thigh", "neck"] as const) {
      expect(Math.abs(r.measurements[k]!.valueCm - t.values[k]), k).toBeLessThan(1);
    }
    for (const k of ["inseam", "sleeveLength", "shoulderWidth", "outseam"] as const) {
      expect(Math.abs(r.measurements[k]!.valueCm - t.values[k]), k).toBeLessThan(0.5);
    }
  });

  it("height-solves a cropped focal length (> 5% off) and still measures correctly", async () => {
    const { body, captures, vision } = setup();
    const profile = profileFor({ ...DEFAULT_CAM, f: DEFAULT_CAM.f * 0.85 });
    const r = await runPipeline({ captures, profile, inputs: inputs(175), factors: null, vision });
    expect(r.solvedFocalLengthPx).toBeDefined();
    expect(Math.abs(r.solvedFocalLengthPx! / DEFAULT_CAM.f - 1)).toBeLessThan(0.01);
    expect(r.retakeViews).toEqual([]);
    const t = truth(body);
    expect(Math.abs(r.measurements.chest!.valueCm - t.values.chest)).toBeLessThan(1);
    expect(Math.abs(r.measurements.inseam!.valueCm - t.values.inseam)).toBeLessThan(0.5);
  });

  it("the solved focal length is reported at the profile's capture size", async () => {
    const { captures, vision } = setup();
    const p = profileFor({ ...DEFAULT_CAM, f: DEFAULT_CAM.f * 0.5 * 0.85 }, { captureWidth: 540, captureHeight: 960 });
    const r = await runPipeline({ captures, profile: p, inputs: inputs(175), factors: null, vision });
    expect(Math.abs(r.solvedFocalLengthPx! / (DEFAULT_CAM.f / 2) - 1)).toBeLessThan(0.01);
  });

  it("flags a view with no person and keeps the rest", async () => {
    const { captures, vision } = setup({ noPerson: ["side"] });
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision });
    expect(r.retakeViews).toEqual([{ view: "side", reason: "no-person" }]);
    expect(r.measurements.chest).toBeUndefined();
    expect(r.measurements.inseam).toBeDefined();
  });

  it("trace: off by default; with trace: true explains each frame and view", async () => {
    const plain = setup({ noPerson: ["side"] });
    const r0 = await runPipeline({ captures: plain.captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision: plain.vision });
    expect(r0.trace).toBeUndefined();

    const { captures, vision } = setup({ noPerson: ["side"], reason: { back: "blurry" } });
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision, trace: true });
    const t = r.trace!;
    expect(t.frames).toHaveLength(9);
    expect(t.frames.map((f) => f.index)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    const front = t.frames.filter((f) => f.view === "front");
    expect(front.every((f) => f.used && f.pose && f.mask && f.distanceCm! > 0 && !!f.feet && !!f.head)).toBe(true);
    expect(front[0].landmarks).toHaveLength(33);
    expect(front[0].keyVisibility).toHaveProperty("lHeel");
    expect(front[0].maskCoverage!).toBeGreaterThan(0);
    const side = t.frames.filter((f) => f.view === "side");
    expect(side.every((f) => !f.used && f.skipped === "no pose found")).toBe(true);
    expect(t.views.map((v) => [v.view, v.decision])).toEqual([["front", "ok"], ["side", "no-person"], ["back", "blurry"]]);
    expect(t.views[2].reasons).toEqual({ blurry: 3 });
    expect(t.views[0].usable).toBe(3);
    expect(t.measurementCount).toBe(Object.keys(r.measurements).length);
    expect(t.thresholds.scaleAgreementLimitPct).toBe(2);
    expect(r.retakeViews).toEqual([{ view: "side", reason: "no-person" }, { view: "back", reason: "blurry" }]);
  });

  it("flags a view whose frames fail the quality check", async () => {
    const { captures, vision } = setup({ reason: { back: "blurry" } });
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision });
    expect(r.retakeViews).toEqual([{ view: "back", reason: "blurry" }]);
    expect(r.diagnostics.qualityScores.back).toBeCloseTo(0.2, 9);
  });

  it("small floor disagreement (lens offset 3% off): tilt solved within tolerance, reported, no retake", async () => {
    const { captures, vision } = setup();
    const profile = profileFor({ ...DEFAULT_CAM, lensOffsetCm: DEFAULT_CAM.lensOffsetCm * 1.03 });
    const r = await runPipeline({ captures, profile, inputs: inputs(175), factors: null, vision, trace: true });
    expect(r.solvedFocalLengthPx).toBeUndefined();
    expect(r.diagnostics.scaleAgreementPct).toBeGreaterThan(2); // raw cross-check still reported
    expect(r.retakeViews).toEqual([]);
    expect(r.trace!.pitchApplied).toBe(true);
    expect(Math.abs(r.trace!.pitchCorrectionDeg!)).toBeLessThan(PITCH_TOLERANCE_DEG);
    expect(r.trace!.rawAgreementPct!.front!).toBeGreaterThan(2);
  });

  it("a view that disagrees with the others (phone moved) is retaken", async () => {
    const { captures, vision } = setup();
    // The sensor says the phone tipped 2.5 deg during the side step, but the image did not change.
    for (const f of captures.find((c) => c.view === "side")!.frames) f.orientation = { ...f.orientation, tiltDeg: f.orientation.tiltDeg + 2.5 };
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision, trace: true });
    expect(r.trace!.pitchApplied).toBe(true);
    expect(r.retakeViews).toEqual([{ view: "side", reason: "distance-mismatch" }]);
  });

  it("tilt correction over tolerance falls back to the focal-length solve", async () => {
    const { captures, vision } = setup();
    const profile = profileFor({ ...DEFAULT_CAM, f: DEFAULT_CAM.f * 0.6 });
    const r = await runPipeline({ captures, profile, inputs: inputs(175), factors: null, vision, trace: true });
    expect(r.trace!.pitchApplied).toBe(false);
    expect(r.solvedFocalLengthPx).toBeDefined();
  });

  it("the solved tilt removes a sub-degree tilt-sensor error (the real-phone failure)", async () => {
    const { body, captures, vision } = setup();
    for (const c of captures) for (const f of c.frames) f.orientation = { ...f.orientation, tiltDeg: f.orientation.tiltDeg + 0.7 };
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision, trace: true });
    expect(r.retakeViews).toEqual([]);
    expect(r.trace!.pitchCorrectionDeg!).toBeCloseTo(0.7, 1);
    const t = truth(body);
    expect(Math.abs(r.measurements.chest!.valueCm - t.values.chest)).toBeLessThan(1.5);
    expect(Math.abs(r.measurements.inseam!.valueCm - t.values.inseam)).toBeLessThan(1);
  });

  it("never throws when vision fails everywhere", async () => {
    const { captures } = setup();
    const broken: VisionApi = {
      detectPoseHeavy: async () => {
        throw new Error("boom");
      },
      segmentPerson: async () => {
        throw new Error("boom");
      },
      frameQuality: () => {
        throw new Error("boom");
      },
    };
    const r = await runPipeline({ captures, profile: profileFor(DEFAULT_CAM), inputs: inputs(175), factors: null, vision: broken });
    expect(r.retakeViews.map((x) => x.reason)).toEqual(["no-person", "no-person", "no-person"]);
    expect(Object.keys(r.measurements)).toEqual(["height"]);
    expect(r.diagnostics.modelVersions).toEqual({});
  });
});

describe("feet and head rows", () => {
  const body = new Body(175);
  const [f] = sceneFrames(body, DEFAULT_CAM, 1, 0, 1);
  it("feetPoint uses heel/toe landmarks and falls back to the mask bottom", () => {
    const p = feetPoint(f.landmarksPx, f.mask)!;
    expect(p.v).toBeGreaterThan(f.landmarksPx[27].y); // below the ankles
    const noFeet = f.landmarksPx.map((l, i) => (i >= 29 ? { ...l, visibility: 0 } : l));
    const q = feetPoint(noFeet, f.mask)!;
    expect(q.v).toBeGreaterThan(f.landmarksPx[27].y);
    expect(feetPoint([], null)).toBeNull();
  });
  it("headPoint uses the mask top row and falls back to landmarks", () => {
    const p = headPoint(f.landmarksPx, f.mask)!;
    expect(p.v).toBeLessThan(f.landmarksPx[0].y);
    const empty = { ...f.mask, data: new Uint8Array(f.mask.data.length) };
    const q = headPoint(f.landmarksPx, empty)!;
    expect(q.v).toBeLessThan(f.landmarksPx[0].y);
    expect(headPoint([], null)).toBeNull();
  });
  it("toPixelLandmarks scales normalized coords", () => {
    expect(toPixelLandmarks([{ x: 0.5, y: 0.25, z: 0, visibility: 1 }], 1080, 1920)[0]).toMatchObject({ x: 540, y: 480 });
  });
});
