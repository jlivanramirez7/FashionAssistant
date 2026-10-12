// Processing pipeline glue (design doc section 7, "Pipeline steps").
// Vision (MediaPipe) is injected through VisionApi so tests never load it.
import {
  LM,
  VIEWS,
  type CameraModel,
  type CapturedFrame,
  type CorrectionFactors,
  type DeviceProfile,
  type FrameTrace,
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
  type ViewTrace,
} from "../types";
import { buildCamera, focalForFrame, withFocalLength } from "../geometry/camera";
import { distanceFromFeet, makeViewPlane, solveFocalLength } from "../geometry/plane";
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
 * PURE: image point where the floor meets the user plane (below the ankles).
 *
 * The feet row drives the distance with a large gain (at h ~ 13.5 cm, d ~ 250 cm, a
 * 1 cm vertical error at the feet moves d by ~18 cm), so the absolute row comes from
 * the mask's lowest row near the feet (the sole/floor contact edge), not from the
 * heel/toe landmarks, whose height above the floor is not reliable. Landmarks only
 * give the RELATIVE offset between the lowest foot point and the floor point under the
 * ankle (heel + ANKLE_ALONG_FOOT * (toe - heel)): in the front view the lowest contact
 * is the toe tips (closer to the camera, lower in the image), in the back view the
 * heels, in the side view the whole sole. Any common landmark offset cancels.
 * Falls back to landmarks alone (no mask) or the mask alone (no foot landmarks).
 */
export function feetPoint(landmarksPx: Landmark[], mask: PersonMask | null): { u: number; v: number } | null {
  const pts: { u: number; v: number }[] = [];
  const footLms: { u: number; v: number }[] = [];
  for (const [h, t] of [[LM.leftHeel, LM.leftFootIndex], [LM.rightHeel, LM.rightFootIndex]] as const) {
    const hp = px(landmarksPx, h);
    const tp = px(landmarksPx, t);
    if (hp) footLms.push(hp);
    if (tp) footLms.push(tp);
    if (hp && tp) pts.push({ u: hp.u + ANKLE_ALONG_FOOT * (tp.u - hp.u), v: hp.v + ANKLE_ALONG_FOOT * (tp.v - hp.v) });
    else if (hp ?? tp) pts.push((hp ?? tp)!);
  }
  const lmPoint = pts.length
    ? { u: pts.reduce((s, p) => s + p.u, 0) / pts.length, v: pts.reduce((s, p) => s + p.v, 0) / pts.length }
    : null;
  if (mask) {
    let uMin: number;
    let uMax: number;
    if (footLms.length) {
      const margin = 0.05 * mask.width;
      uMin = Math.min(...footLms.map((p) => p.u)) - margin;
      uMax = Math.max(...footLms.map((p) => p.u)) + margin;
    } else {
      const a = px(landmarksPx, LM.leftAnkle);
      const b = px(landmarksPx, LM.rightAnkle);
      const cu = a && b ? (a.u + b.u) / 2 : (a ?? b)?.u ?? mask.width / 2;
      uMin = cu - 0.15 * mask.width;
      uMax = cu + 0.15 * mask.width;
    }
    const r = bottomRow(mask, uMin, uMax);
    if (r !== null) {
      const contact = r + 1; // bottom edge of the lowest mask row
      if (lmPoint && footLms.length) {
        const lowest = Math.max(...footLms.map((p) => p.v));
        return { u: lmPoint.u, v: contact - Math.max(0, lowest - lmPoint.v) };
      }
      return { u: lmPoint?.u ?? (uMin + uMax) / 2, v: contact };
    }
  }
  return lmPoint;
}

/** Side view: the lowest mask point is the near foot's outer edge, about half a foot width (fraction of height) nearer than the user plane. */
export const SIDE_FOOT_HALF_WIDTH_FRAC = 0.025;

/**
 * PURE: feet row moved so the floor distance grows by deltaCm (secant on distanceFromFeet).
 * Returns the input row when the distance cannot be determined.
 */
export function shiftFeetRow(cam: CameraModel, v: number, u: number, deltaCm: number): number {
  const d0 = distanceFromFeet(cam, v, u);
  if (!(d0 > 0) || !deltaCm) return v;
  const target = d0 + deltaCm;
  let a = v;
  let fa = d0 - target;
  let b = v - 1;
  let fb = distanceFromFeet(cam, b, u) - target;
  for (let i = 0; i < 20 && Math.abs(fb) > 1e-4; i++) {
    if (!(Math.abs(fb - fa) > 1e-12)) break;
    const c = b - (fb * (b - a)) / (fb - fa);
    const dc = distanceFromFeet(cam, c, u);
    if (!(dc > 0)) break;
    a = b;
    fa = fb;
    b = c;
    fb = dc - target;
  }
  return Math.abs(fb) < 0.5 ? b : v;
}

/** Feet row used for the geometry of a view (side-view near-foot correction). */
export function feetRowFor(cam: CameraModel, view: ViewName, feet: { u: number; v: number }, heightCm: number): number {
  return view === "side" && heightCm > 0 ? shiftFeetRow(cam, feet.v, feet.u, SIDE_FOOT_HALF_WIDTH_FRAC * heightCm) : feet.v;
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
  /** Focal length (profile resolution) this frame alone implies. */
  solvedF?: number;
}

const KEY_LANDMARKS: [string, number][] = [
  ["nose", LM.nose],
  ["lShoulder", LM.leftShoulder],
  ["rShoulder", LM.rightShoulder],
  ["lHip", LM.leftHip],
  ["rHip", LM.rightHip],
  ["lAnkle", LM.leftAnkle],
  ["rAnkle", LM.rightAnkle],
  ["lHeel", LM.leftHeel],
  ["rHeel", LM.rightHeel],
  ["lToe", LM.leftFootIndex],
  ["rToe", LM.rightFootIndex],
];

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function maskCoverage(mask: PersonMask): number {
  let n = 0;
  const d = mask.data;
  for (let i = 0; i < d.length; i++) if (d[i]) n++;
  return d.length ? n / d.length : 0;
}

/** Trace record for one frame (troubleshooting reports). */
function frameTrace(w: FrameWork, index: number, landmarksNorm: Landmark[] | null): FrameTrace {
  const used = !!w.plane;
  const t: FrameTrace = {
    view: w.view,
    index,
    width: w.frame.width,
    height: w.frame.height,
    tiltDeg: r1(w.frame.orientation.tiltDeg),
    rollDeg: r1(w.frame.orientation.rollDeg),
    pose: !!landmarksNorm,
    mask: !!w.mask,
    used,
  };
  if (landmarksNorm) {
    t.keyVisibility = Object.fromEntries(KEY_LANDMARKS.map(([k, i]) => [k, r3(landmarksNorm[i]?.visibility ?? 0)]));
    t.landmarks = landmarksNorm.map((l) => ({ x: r3(l.x), y: r3(l.y), v: r3(l.visibility ?? 0) }));
  }
  if (w.mask) t.maskCoverage = r3(maskCoverage(w.mask));
  if (w.mask?.info) t.maskInfo = { ...w.mask.info };
  const ls = px(w.landmarksPx, LM.leftShoulder);
  const rs = px(w.landmarksPx, LM.rightShoulder);
  if (ls && rs && w.feet && w.head && w.feet.v - w.head.v > 0) {
    t.shoulderRatio = r3(Math.hypot(ls.u - rs.u, ls.v - rs.v) / (w.feet.v - w.head.v));
  }
  if (w.quality) {
    t.quality = { ...w.quality, sharpness: r3(w.quality.sharpness), score: r3(w.quality.score) };
  }
  if (w.feet) t.feet = { u: r1(w.feet.u), v: r1(w.feet.v) };
  if (w.head) t.head = { u: r1(w.head.u), v: r1(w.head.v) };
  if (w.solvedF !== undefined) t.focalSolvedPx = r1(w.solvedF);
  if (w.plane) {
    t.distanceCm = r1(w.plane.distanceCm);
    t.heightScale = r3(w.plane.heightScale);
    t.scaleAgreementPct = r3(w.plane.scaleAgreementPct);
  } else {
    t.skipped = !landmarksNorm
      ? "no pose found"
      : !w.mask
        ? "no person outline (segmentation failed)"
        : !w.feet
          ? "feet not found"
          : !w.head
            ? "top of head not found"
            : "not used";
  }
  return t;
}

export async function runPipeline(args: {
  captures: ViewCapture[];
  profile: DeviceProfile;
  inputs: ScanInputs;
  factors: CorrectionFactors | null;
  onProgress?: ProgressFn;
  vision?: VisionApi;
  /** Attach a per-frame trace to the result (troubleshooting reports). */
  trace?: boolean;
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
    const f = solveFocalLength(w.camera, feetRowFor(w.camera, w.view, w.feet, H), w.head.v, H, w.view, { uFeet: w.feet.u, uHead: w.head.u });
    if (f !== null) {
      const scale = focalForFrame(profile, w.frame.width, w.frame.height) / profile.focalLengthPx;
      if (scale > 0) {
        solvedProfileF.push(f / scale);
        w.solvedF = f / scale;
      }
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
  const viewTraces: ViewTrace[] = [];
  const capturedViews = VIEWS.filter((v) => captures.some((c) => c.view === v));
  for (const view of capturedViews) {
    progress(view, 0);
    const ws = work.filter((w) => w.view === view);
    const frames: FrameData[] = [];
    const agreements: number[] = [];
    const dists: number[] = [];
    ws.forEach((w, i) => {
      if (w.landmarksPx && w.mask && w.feet && w.head) {
        w.plane = makeViewPlane(w.camera, view, feetRowFor(w.camera, view, w.feet, H), w.head.v, H, { uFeet: w.feet.u, uHead: w.head.u });
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
    const reasons = ws.map((w) => w.quality?.reason).filter((r): r is RetakeReason => !!r);
    const counts = new Map<RetakeReason, number>();
    for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    let decision: ViewTrace["decision"] = "ok";
    if (frames.length === 0) decision = "no-person";
    else if (reasons.length * 2 > ws.length) decision = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    else if (aMed !== null && aMed > SCALE_AGREEMENT_LIMIT_PCT) decision = "distance-mismatch";
    if (decision !== "ok") retakeViews.push({ view, reason: decision });
    viewTraces.push({
      view,
      frames: ws.length,
      usable: frames.length,
      ...(qMed !== null ? { qualityMedian: r3(qMed) } : {}),
      ...(aMed !== null ? { agreementMedianPct: r3(aMed) } : {}),
      ...(dMed !== null ? { distanceMedianCm: r1(dMed) } : {}),
      reasons: Object.fromEntries(counts),
      decision,
    });
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
  if (args.trace) {
    const perView = new Map<ViewName, number>();
    result.trace = {
      frames: work.map((w, i) => {
        const index = perView.get(w.view) ?? 0;
        perView.set(w.view, index + 1);
        return frameTrace(w, index, lmsNorm[i]);
      }),
      views: viewTraces,
      focalSpecPx: profile.focalLengthPx,
      ...(fSolved !== null ? { focalSolvedPx: r1(fSolved) } : {}),
      focalOverride: useSolved,
      measurementCount: Object.keys(measurements).length,
      thresholds: {
        scaleAgreementLimitPct: SCALE_AGREEMENT_LIMIT_PCT,
        focalOverrideFrac: FOCAL_OVERRIDE_FRAC,
        minVisibility: MIN_VISIBILITY,
      },
    };
  }
  return result;
}
