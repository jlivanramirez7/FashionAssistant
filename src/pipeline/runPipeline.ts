// Processing pipeline glue (design doc section 7, "Pipeline steps").
// Vision (MediaPipe) is injected through VisionApi so tests never load it.
import {
  LM,
  VIEWS,
  type CameraModel,
  type CapturedFrame,
  type CorrectionFactors,
  type DeviceProfile,
  type Landmark,
  type PersonMask,
  type PipelineResult,
  type ProgressFn,
  type QualityScore,
  type RetakeReason,
  type ScanInputs,
  type ViewCapture,
  type ViewName,
  type ViewPlane,
} from "../types";
import { buildCamera, focalForFrame, withFocalLength } from "../geometry/camera";
import { makeViewPlane, solveFocalLength } from "../geometry/plane";
import { computeMeasurements, MIN_VISIBILITY, type FrameData, type ViewData } from "../measure/compute";
import { bottomRow, topRow } from "../measure/silhouette";

export interface VisionApi {
  detectPoseHeavy: typeof import("../vision").detectPoseHeavy;
  segmentPerson: typeof import("../vision").segmentPerson;
  frameQuality: typeof import("../vision").frameQuality;
  /** Optional: reported in diagnostics.modelVersions (the default loader fills it). */
  modelVersions?: Record<string, string>;
}

/** Solved focal length replaces the spec value when they differ by more than this. */
export const FOCAL_OVERRIDE_FRAC = 0.05;
/** Height vs floor-geometry disagreement that triggers a retake (percent). */
export const SCALE_AGREEMENT_LIMIT_PCT = 2;
/** Fraction of the heel->toe span where the floor point under the ankle is assumed. */
export const ANKLE_ALONG_FOOT = 0.2;

async function loadVision(): Promise<VisionApi> {
  const mod = await import("../vision");
  return {
    detectPoseHeavy: mod.detectPoseHeavy,
    segmentPerson: mod.segmentPerson,
    frameQuality: mod.frameQuality,
    modelVersions: (mod as { MODEL_VERSIONS?: Record<string, string> }).MODEL_VERSIONS,
  };
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function px(lms: Landmark[] | null | undefined, i: number): { u: number; v: number } | null {
  const l = lms?.[i];
  if (!l || !fin(l.x) || !fin(l.y)) return null;
  if (fin(l.visibility) && l.visibility < MIN_VISIBILITY) return null;
  return { u: l.x, v: l.y };
}

/** PURE: normalized landmarks -> pixel landmarks. */
export function toPixelLandmarks(lms: Landmark[], width: number, height: number): Landmark[] {
  return lms.map((l) => ({ ...l, x: l.x * width, y: l.y * height }));
}

/**
 * PURE: image row (and column) where the feet touch the floor below the ankles.
 * Per foot: heel row + ANKLE_ALONG_FOOT * (toe row - heel row); averaged over feet.
 * Falls back to the bottom mask row. landmarksPx in pixels.
 */
export function feetPoint(landmarksPx: Landmark[], mask: PersonMask | null): { u: number; v: number } | null {
  const pts: { u: number; v: number }[] = [];
  for (const [h, t] of [[LM.leftHeel, LM.leftFootIndex], [LM.rightHeel, LM.rightFootIndex]] as const) {
    const hp = px(landmarksPx, h);
    const tp = px(landmarksPx, t);
    if (hp && tp) pts.push({ u: hp.u + ANKLE_ALONG_FOOT * (tp.u - hp.u), v: hp.v + ANKLE_ALONG_FOOT * (tp.v - hp.v) });
    else if (hp ?? tp) pts.push((hp ?? tp)!);
  }
  if (pts.length) return { u: pts.reduce((s, p) => s + p.u, 0) / pts.length, v: pts.reduce((s, p) => s + p.v, 0) / pts.length };
  if (mask) {
    const a = px(landmarksPx, LM.leftAnkle);
    const b = px(landmarksPx, LM.rightAnkle);
    const cu = a && b ? (a.u + b.u) / 2 : (a ?? b)?.u ?? mask.width / 2;
    const r = bottomRow(mask, cu - 0.15 * mask.width, cu + 0.15 * mask.width);
    if (r !== null) return { u: cu, v: r + 1 };
  }
  return null;
}

/**
 * PURE: image row (and column) of the top of the head: the top-most mask row near the
 * head column (top edge of that pixel row). Falls back to a landmark estimate.
 */
export function headPoint(landmarksPx: Landmark[], mask: PersonMask | null): { u: number; v: number } | null {
  const nose = px(landmarksPx, LM.nose);
  const ears = [px(landmarksPx, LM.leftEar), px(landmarksPx, LM.rightEar)].filter((p) => p !== null);
  const hu = ears.length ? ears.reduce((s, p) => s + p!.u, 0) / ears.length : nose?.u;
  const sh = [px(landmarksPx, LM.leftShoulder), px(landmarksPx, LM.rightShoulder)].filter((p) => p !== null);
  if (mask) {
    const cu = hu ?? mask.width / 2;
    const r = topRow(mask, cu - 0.12 * mask.width, cu + 0.12 * mask.width);
    if (r !== null) return { u: cu, v: r };
  }
  if (nose && sh.length) {
    const shV = sh.reduce((s, p) => s + p!.v, 0) / sh.length;
    return { u: nose.u, v: nose.v - 0.6 * (shV - nose.v) };
  }
  return null;
}

function median(xs: number[]): number | null {
  const v = xs.filter(fin).sort((a, b) => a - b);
  if (!v.length) return null;
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

function asImageData(image: CapturedFrame["image"]): ImageData | null {
  if (image && typeof image === "object" && "data" in image) return image as ImageData;
  try {
    if (typeof OffscreenCanvas !== "undefined" && image && "width" in image) {
      const c = new OffscreenCanvas(image.width, image.height);
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(image as ImageBitmap, 0, 0);
      return ctx.getImageData(0, 0, image.width, image.height);
    }
  } catch {
    /* quality check is skipped */
  }
  return null;
}

interface FrameWork {
  view: ViewName;
  frame: CapturedFrame;
  landmarksPx: Landmark[] | null;
  mask: PersonMask | null;
  quality: QualityScore | null;
  camera: CameraModel;
  feet: { u: number; v: number } | null;
  head: { u: number; v: number } | null;
  plane?: ViewPlane;
}

export async function runPipeline(args: {
  captures: ViewCapture[];
  profile: DeviceProfile;
  inputs: ScanInputs;
  factors: CorrectionFactors | null;
  onProgress?: ProgressFn;
  vision?: VisionApi;
}): Promise<PipelineResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { captures, profile, inputs, factors } = args;
  const progress: ProgressFn = (s, f) => {
    try {
      args.onProgress?.(s, Math.min(1, Math.max(0, f)));
    } catch {
      /* UI errors must not break processing */
    }
  };
  const vision = args.vision ?? (await loadVision());
  const H = inputs.heightCm;

  const all: { view: ViewName; frame: CapturedFrame }[] = [];
  for (const c of captures) for (const frame of c.frames) all.push({ view: c.view, frame });

  // 1-2. Heavy pose on every frame.
  const lmsNorm: (Landmark[] | null)[] = [];
  for (let i = 0; i < all.length; i++) {
    progress("pose", i / Math.max(1, all.length));
    let l: Landmark[] | null = null;
    try {
      l = await vision.detectPoseHeavy(all[i].frame.image);
    } catch {
      l = null;
    }
    lmsNorm.push(l && l.length ? l : null);
  }
  progress("pose", 1);

  // 4. Segmentation (+ quality).
  const work: FrameWork[] = [];
  for (let i = 0; i < all.length; i++) {
    progress("outline", i / Math.max(1, all.length));
    const { view, frame } = all[i];
    const ln = lmsNorm[i];
    let mask: PersonMask | null = null;
    if (ln) {
      try {
        mask = await vision.segmentPerson(frame.image, ln);
      } catch {
        mask = null;
      }
    }
    let quality: QualityScore | null = null;
    const img = asImageData(frame.image);
    if (img) {
      try {
        quality = vision.frameQuality(img, ln);
      } catch {
        quality = null;
      }
    }
    const landmarksPx = ln ? toPixelLandmarks(ln, frame.width, frame.height) : null;
    work.push({
      view,
      frame,
      landmarksPx,
      mask,
      quality,
      camera: buildCamera(profile, frame.orientation, frame.width, frame.height),
      feet: landmarksPx ? feetPoint(landmarksPx, mask) : null,
      head: landmarksPx ? headPoint(landmarksPx, mask) : null,
    });
  }
  progress("outline", 1);

  // Height solve for the focal length (section 4): median over frames, at profile size.
  const solvedProfileF: number[] = [];
  for (const w of work) {
    if (!w.feet || !w.head) continue;
    const f = solveFocalLength(w.camera, w.feet.v, w.head.v, H, w.view, { uFeet: w.feet.u, uHead: w.head.u });
    if (f !== null) {
      const scale = focalForFrame(profile, w.frame.width, w.frame.height) / profile.focalLengthPx;
      if (scale > 0) solvedProfileF.push(f / scale);
    }
  }
  const fSolved = median(solvedProfileF);
  let useSolved = false;
  if (fSolved !== null && profile.focalLengthPx > 0) {
    useSolved = Math.abs(fSolved - profile.focalLengthPx) / profile.focalLengthPx > FOCAL_OVERRIDE_FRAC;
  }
  if (useSolved && fSolved !== null) {
    for (const w of work) {
      const scale = focalForFrame(profile, w.frame.width, w.frame.height) / profile.focalLengthPx;
      w.camera = withFocalLength(w.camera, fSolved * scale);
    }
  }

  // 3. Planes per frame, per view.
  const viewData: ViewData[] = [];
  const retakeViews: { view: ViewName; reason: RetakeReason }[] = [];
  const distanceM: Partial<Record<ViewName, number>> = {};
  const qualityScores: Partial<Record<ViewName, number>> = {};
  let worstAgreement = 0;
  const capturedViews = VIEWS.filter((v) => captures.some((c) => c.view === v));
  for (const view of capturedViews) {
    progress(view, 0);
    const ws = work.filter((w) => w.view === view);
    const frames: FrameData[] = [];
    const agreements: number[] = [];
    const dists: number[] = [];
    ws.forEach((w, i) => {
      if (w.landmarksPx && w.mask && w.feet && w.head) {
        w.plane = makeViewPlane(w.camera, view, w.feet.v, w.head.v, H, { uFeet: w.feet.u, uHead: w.head.u });
        frames.push({ landmarksPx: w.landmarksPx, mask: w.mask, plane: w.plane });
        agreements.push(w.plane.scaleAgreementPct);
        dists.push(w.plane.distanceCm);
      }
      progress(view, (i + 1) / Math.max(1, ws.length));
    });
    viewData.push({ view, frames });
    const qs = ws.map((w) => w.quality?.score).filter(fin);
    const qMed = median(qs);
    if (qMed !== null) qualityScores[view] = qMed;
    const dMed = median(dists);
    if (dMed !== null) distanceM[view] = dMed / 100;
    const aMed = median(agreements);
    if (aMed !== null) worstAgreement = Math.max(worstAgreement, aMed);

    // Retake decisions.
    if (frames.length === 0) {
      retakeViews.push({ view, reason: "no-person" });
      continue;
    }
    const reasons = ws.map((w) => w.quality?.reason).filter((r): r is RetakeReason => !!r);
    if (reasons.length * 2 > ws.length) {
      const counts = new Map<RetakeReason, number>();
      for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      retakeViews.push({ view, reason: top });
      continue;
    }
    if (aMed !== null && aMed > SCALE_AGREEMENT_LIMIT_PCT) retakeViews.push({ view, reason: "distance-mismatch" });
  }

  // 5-9. Measurements.
  progress("measure", 0);
  const { measurements, rawMeasurements } = computeMeasurements(viewData, inputs, factors, {
    hasDistortionK1: fin(profile.distortionK1) && profile.distortionK1 !== 0,
  });
  progress("measure", 1);

  const first = all[0]?.frame;
  const orient = all.map((a) => a.frame.orientation);
  const avg = (xs: number[]) => {
    const v = xs.filter(fin);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const result: PipelineResult = {
    measurements,
    rawMeasurements,
    retakeViews,
    diagnostics: {
      videoWidth: first?.width ?? profile.captureWidth,
      videoHeight: first?.height ?? profile.captureHeight,
      focalLengthPxSpec: profile.focalLengthPx,
      ...(fSolved !== null ? { focalLengthPxSolved: fSolved } : {}),
      lensOffsetCm: profile.lensOffsetCm,
      lensHeightCm: median(work.map((w) => w.camera.lensHeightCm)) ?? 0,
      tiltDeg: avg(orient.map((o) => o.tiltDeg)),
      rollDeg: avg(orient.map((o) => o.rollDeg)),
      distanceM,
      scaleAgreementPct: worstAgreement,
      qualityScores,
      processingMs: Math.max(0, t1 - t0),
      modelVersions: vision.modelVersions ?? {},
    },
  };
  if (useSolved && fSolved !== null) result.solvedFocalLengthPx = fSolved;
  return result;
}
