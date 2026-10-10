// QA: end-to-end pipeline on a synthetic, exactly-known scene (C glue + D API
// shape). The fake VisionApi returns NORMALIZED landmarks (as MediaPipe does)
// and full-frame pixel masks, so this catches normalized-vs-pixel mix-ups,
// per-view distance, chest = bust, k defaults, confidence rules and retakes.
// Ground truth: a flat "cardboard" person (tests/qa/_scene.ts) 175 cm tall,
// torso 34 cm wide x 24 cm deep, standing 250 cm from the lens.
import { beforeAll, describe, expect, it } from "vitest";
import { MEASUREMENT_SPECS, type CorrectionFactors, type Landmark, type PersonMask, type ViewCapture, type ViewName } from "../../src/types";
import { fn, loadModule, near } from "./_helpers";
import { BODY, makeProfile, ramanujan, renderView, type SceneCam, type ViewScene } from "./_scene";

const RUN = "src/pipeline/runPipeline";
const W = 720, H = 1280;
const CAM: SceneCam = { width: W, height: H, f: 1000, thetaDeg: 75, lensOffsetCm: 14 };
const D = 250;
const FRAMES = 3;

// Node has no ImageData; give the pipeline a structurally correct one.
class QAImageData {
  readonly colorSpace = "srgb";
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}
const g = globalThis as unknown as { ImageData?: unknown };
if (typeof g.ImageData === "undefined") g.ImageData = QAImageData;

let scenes: Record<ViewName, ViewScene>;
const pixels = new Uint8ClampedArray(W * H * 4).fill(128);

beforeAll(() => {
  scenes = {
    front: renderView(CAM, "front", D),
    side: renderView(CAM, "side", D),
    back: renderView(CAM, "back", D),
  };
});

function buildCaptures(): { captures: ViewCapture[]; viewOf: Map<object, ViewName> } {
  const viewOf = new Map<object, ViewName>();
  const captures: ViewCapture[] = (["front", "side", "back"] as ViewName[]).map((view, vi) => ({
    view,
    frames: Array.from({ length: FRAMES }, (_, i) => {
      const image = new (g.ImageData as typeof QAImageData)(pixels, W, H) as unknown as ImageData;
      viewOf.set(image, view);
      return { view, timestampMs: vi * 10_000 + i * 100, image, width: W, height: H, orientation: { tiltDeg: 75, rollDeg: 0 } };
    }),
  }));
  return { captures, viewOf };
}

function fakeVision(viewOf: Map<object, ViewName>, opts: { noPerson?: ViewName } = {}) {
  const calls = { pose: 0, seg: 0, quality: 0, segLandmarksNormalized: true };
  return {
    calls,
    api: {
      detectPoseHeavy: async (img: object): Promise<Landmark[] | null> => {
        calls.pose++;
        const v = viewOf.get(img);
        if (!v) throw new Error("QA fake: detectPoseHeavy got an image that is not a captured frame");
        if (v === opts.noPerson) return null;
        return scenes[v].landmarks.map((l) => ({ ...l }));
      },
      segmentPerson: async (img: object, lms: Landmark[]): Promise<PersonMask> => {
        calls.seg++;
        if (lms.some((l) => l.x > 1.5 || l.y > 1.5)) calls.segLandmarksNormalized = false;
        const v = viewOf.get(img);
        if (!v) throw new Error("QA fake: segmentPerson got an image that is not a captured frame");
        return scenes[v].mask;
      },
      frameQuality: (_img: unknown, lms: Landmark[] | null) => {
        calls.quality++;
        return lms ? { sharpness: 0.9, inFrame: true, score: 0.9 } : { sharpness: 0.9, inFrame: false, score: 0, reason: "no-person" as const };
      },
    },
  };
}

async function run(factors: CorrectionFactors | null, opts: { noPerson?: ViewName; heightCm?: number } = {}) {
  const m = await loadModule(RUN, "C geometry-measure");
  const runPipeline = fn(m, "runPipeline", "C geometry-measure", RUN);
  const { captures, viewOf } = buildCaptures();
  const fv = fakeVision(viewOf, opts);
  const progress: [string, number][] = [];
  const result = await runPipeline({
    captures,
    profile: makeProfile(CAM),
    inputs: { heightCm: opts.heightCm ?? BODY.heightCm, bodyType: "unspecified", subjectLabel: "me" },
    factors,
    onProgress: (s: string, f: number) => progress.push([s, f]),
    vision: fv.api,
  });
  return { result, calls: fv.calls, progress };
}

describe("[QA] synthetic scene self-check (ground truth is sound)", () => {
  it("mask bottom = feet row, landmarks normalized, torso 34 cm wide at chest height", async () => {
    const { project, unprojectToPlane } = await import("./_scene");
    const s = scenes.front;
    let bottom = -1;
    for (let v = H - 1; v >= 0 && bottom < 0; v--) for (let u = 0; u < W; u++) if (s.mask.data[v * W + u]) { bottom = v; break; }
    near(bottom, s.vFeet, 1.5, "lowest mask row vs projected feet row");
    for (const l of s.landmarks) expect(l.x > 0 && l.x < 1 && l.y > 0 && l.y < 1).toBe(true);
    const v = Math.round(project(CAM, 0, 125, D).v);
    let u0 = W / 2, u1 = W / 2;
    while (s.mask.data[v * W + u0 - 1]) u0--;
    while (s.mask.data[v * W + u1 + 1]) u1++;
    const width = unprojectToPlane(CAM, u1 + 1, v, D).X - unprojectToPlane(CAM, u0, v, D).X;
    near(width, BODY.torsoWidth, 0.6, "torso width from mask");
  });
});

describe("[C geometry-measure] runPipeline on a synthetic scene", () => {
  it("geometry: per-view distance 2.5 m, height agreement < 2%, no retakes, spec focal kept", async () => {
    const { result, calls, progress } = await run(null);
    expect(calls.pose, "heavy pose on every kept frame").toBe(3 * FRAMES);
    expect(calls.seg, "segmentation was called").toBeGreaterThan(0);
    expect(calls.segLandmarksNormalized, "segmentPerson must receive NORMALIZED landmarks (D contract)").toBe(true);
    // Feet convention (orchestrator): heel/foot-index are floor contacts; the feet row comes
    // from the mask bottom. Side view: C assumes the near foot's outer edge is 0.025*H nearer
    // than the body plane; QA's flat scene has no foot depth, so allow +/-5 cm there.
    near(result.diagnostics.distanceM.front, D / 100, 0.02, "distanceM.front (metres)");
    near(result.diagnostics.distanceM.back, D / 100, 0.02, "distanceM.back (metres)");
    near(result.diagnostics.distanceM.side, D / 100, 0.05, "distanceM.side (metres)");
    expect(result.diagnostics.scaleAgreementPct).toBeLessThan(2);
    expect(result.retakeViews).toEqual([]);
    expect(result.solvedFocalLengthPx, "spec focal is exact; height solve must not override (< 5%)").toBeUndefined();
    near(result.diagnostics.lensHeightCm, 14 * Math.sin((75 * Math.PI) / 180), 0.05, "lensHeightCm");
    expect(result.diagnostics.videoWidth).toBe(W);
    expect(result.diagnostics.videoHeight).toBe(H);
    expect(result.diagnostics.processingMs).toBeGreaterThanOrEqual(0);
    expect(progress.length, "onProgress called").toBeGreaterThan(0);
    for (const [, f] of progress) expect(f >= 0 && f <= 1, `progress fraction ${f}`).toBe(true);
  }, 120_000);

  it("values: chest/waist/hips within +/-3 cm of the true ellipse; bust === chest; inseam plausible", async () => {
    const { result } = await run(null);
    const m = result.measurements;
    const truth = ramanujan(BODY.torsoWidth, BODY.torsoDepth); // ~91.8 cm
    for (const k of ["chest", "naturalWaist", "hips"] as const) {
      expect(m[k], `measurements.${k} missing`).toBeDefined();
      near(m[k]!.valueCm, truth, 3, `${k} circumference`);
    }
    expect(m.bust, "bust missing").toBeDefined();
    expect(m.bust!.valueCm, "bust must equal chest").toBe(m.chest!.valueCm);
    expect(m.inseam, "inseam missing").toBeDefined();
    expect(m.inseam!.valueCm).toBeGreaterThan(BODY.crotchY - BODY.ankleY - 3);
    expect(m.inseam!.valueCm).toBeLessThan(BODY.crotchY + 3);
    if (m.height) near(m.height.valueCm, BODY.heightCm, 1, "height");
  }, 120_000);

  it("every reported value is finite with uncertainty > 0 (distortion term, no k1) and confidence rules", async () => {
    const { result } = await run(null);
    const problems: string[] = [];
    for (const [k, v] of Object.entries(result.measurements) as [string, { valueCm: number; uncertaintyCm: number; confidence: number }][]) {
      if (!Number.isFinite(v.valueCm) || v.valueCm <= 0) problems.push(`${k}.valueCm=${v.valueCm}`);
      if (k !== "height" && !(v.uncertaintyCm > 0)) problems.push(`${k}.uncertaintyCm=${v.uncertaintyCm} (must include the distortion term when distortionK1 is unset)`);
      if (!(v.confidence >= 0 && v.confidence <= 1)) problems.push(`${k}.confidence=${v.confidence}`);
      const spec = MEASUREMENT_SPECS.find((s) => s.key === k);
      if (!spec) problems.push(`${k} is not a MeasurementKey`);
      if (spec?.alwaysLowConfidence && v.confidence > 0.7) problems.push(`${k}.confidence=${v.confidence} > 0.7 (alwaysLowConfidence)`);
    }
    for (const [k, v] of Object.entries(result.rawMeasurements)) if (!Number.isFinite(v as number)) problems.push(`raw.${k}=${v}`);
    expect(problems, problems.join("\n")).toEqual([]);
    expect(Object.keys(result.measurements).length, "keys reported").toBeGreaterThanOrEqual(15);
  }, 120_000);

  it("k defaults to 1.0; factors apply per bodyType to measurements only (raw stays uncorrected)", async () => {
    const base = await run(null);
    near(base.result.measurements.chest!.valueCm, base.result.rawMeasurements.chest!, 1e-9, "k=1 when factors are null");
    const empty = await run({ male: {}, female: {}, unspecified: {} });
    near(empty.result.measurements.chest!.valueCm, base.result.measurements.chest!.valueCm, 1e-9, "missing key => k=1");
    const f = await run({ male: { chest: 2 }, female: { chest: 2 }, unspecified: { chest: 1.1 } });
    near(f.result.rawMeasurements.chest!, base.result.rawMeasurements.chest!, 1e-9, "raw chest unchanged by k");
    near(f.result.measurements.chest!.valueCm, base.result.rawMeasurements.chest! * 1.1, 1e-6, "chest = raw * k(unspecified)");
  }, 240_000);

  it("retake: a view with no person is flagged (only that view)", async () => {
    const { result } = await run(null, { noPerson: "side" });
    const views = result.retakeViews.map((r: { view: string }) => r.view);
    expect(views).toContain("side");
    expect(views).not.toContain("front");
  }, 120_000);

  it("scale cross-check: typed height 5% too tall is noticed (retake or height-solve override)", async () => {
    const { result } = await run(null, { heightCm: BODY.heightCm * 1.05 });
    const noticed = result.retakeViews.length > 0 || result.solvedFocalLengthPx !== undefined || result.diagnostics.scaleAgreementPct > 2;
    expect(noticed, `scaleAgreementPct=${result.diagnostics.scaleAgreementPct}, retakes=${JSON.stringify(result.retakeViews)}`).toBe(true);
  }, 120_000);
});
