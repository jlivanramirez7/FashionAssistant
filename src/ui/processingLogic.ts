// PURE helpers for the Processing screen (unit-tested).
import {
  VIEWS,
  type DeviceProfile,
  type PipelineResult,
  type ProgressStage,
  type ScanDoc,
  type ViewName,
} from "../types";
import type { ScanSession } from "./context";

/** A step flagged by the quality check is retaken at most this often. */
export const MAX_RETAKES_PER_STEP = 2;

export const STAGE_ORDER: readonly ProgressStage[] = ["pose", "outline", "front", "side", "back", "measure"];
export const STAGE_TEXT: Record<ProgressStage, string> = {
  pose: "Finding your pose",
  outline: "Finding your outline",
  front: "Measuring the front",
  side: "Measuring the side",
  back: "Measuring the back",
  measure: "Calculating",
};

/**
 * Share of the bar per stage. runPipeline reports onProgress(stage, 0..1)
 * PER STAGE in this order; heavy pose and segmentation run per frame and
 * take almost all the time, the per-view planes and the measuring are quick.
 */
export const STAGE_WEIGHTS: Record<ProgressStage, number> = {
  pose: 0.45,
  outline: 0.45,
  front: 0.02,
  side: 0.02,
  back: 0.02,
  measure: 0.04,
};

/** PURE: overall progress 0..1 from (stage, fraction within stage). */
export function overallProgress(stage: ProgressStage, fraction: number): number {
  const i = STAGE_ORDER.indexOf(stage);
  if (i < 0) return 0;
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  let before = 0;
  for (let k = 0; k < i; k++) before += STAGE_WEIGHTS[STAGE_ORDER[k]];
  return Math.min(1, before + f * STAGE_WEIGHTS[stage]);
}

/** PURE: split pipeline retake requests into ones to retake now and ones over the limit. */
export function planRetakes(
  requested: PipelineResult["retakeViews"],
  counts: Partial<Record<ViewName, number>>,
  max = MAX_RETAKES_PER_STEP,
): { retake: PipelineResult["retakeViews"]; unresolved: ViewName[] } {
  const retake: PipelineResult["retakeViews"] = [];
  const unresolved: ViewName[] = [];
  for (const r of requested) {
    if ((counts[r.view] ?? 0) < max) {
      if (!retake.some((x) => x.view === r.view)) retake.push(r);
    } else if (!unresolved.includes(r.view)) unresolved.push(r.view);
  }
  return { retake, unresolved };
}

/** PURE: the ScanDoc for a finished pipeline run. */
export function buildScanDoc(args: {
  session: Pick<ScanSession, "inputs" | "profile" | "retakes" | "unresolved" | "captures">;
  result: PipelineResult;
  deviceId: string;
  appVersion: string;
  userAgent: string;
  now: number;
}): ScanDoc {
  const { session, result } = args;
  const inputs = session.inputs!;
  const profile = session.profile!;
  return {
    createdAt: args.now,
    status: session.unresolved.length > 0 ? "partial" : "complete",
    heightCm: inputs.heightCm,
    bodyType: inputs.bodyType,
    subjectLabel: inputs.subjectLabel,
    scaleSource: "height+floor",
    deviceId: args.deviceId,
    appVersion: args.appVersion,
    viewsCaptured: VIEWS.filter((v) => (session.captures[v]?.length ?? 0) > 0),
    measurements: result.measurements,
    rawMeasurements: result.rawMeasurements,
    diagnostics: {
      ...result.diagnostics,
      userAgent: args.userAgent,
      deviceModelGuess: profile.deviceModelGuess,
      modelSource: profile.modelSource,
      retakes: [...session.retakes],
    },
  };
}

/** A scan's zoom sample further than this from the current value is ignored (bad scan). */
export const FOCAL_SAMPLE_MAX_DEV = 0.3;

/**
 * PURE: device record to save after a scan. A height-solve override (the
 * floor could not be explained by tilt) replaces f_y; otherwise a scan's
 * zoom sample joins a running average in which the starting value (spec or
 * earlier average) counts as calibrationScans + 1 samples. Paper calibration
 * is never overwritten by samples.
 */
export function updatedProfile(
  profile: DeviceProfile,
  solvedFocalLengthPx: number | undefined,
  focalSamplePx?: number,
): DeviceProfile {
  const ok = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x > 0;
  if (!ok(solvedFocalLengthPx)) {
    if (!ok(focalSamplePx) || profile.focalLengthSource === "paper" || !(profile.focalLengthPx > 0)) return profile;
    if (Math.abs(focalSamplePx / profile.focalLengthPx - 1) > FOCAL_SAMPLE_MAX_DEV) return profile;
    const w = Math.max(0, profile.calibrationScans) + 1;
    return {
      ...profile,
      focalLengthPx: (profile.focalLengthPx * w + focalSamplePx) / (w + 1),
      focalLengthSource: "height-solve",
      calibrationScans: profile.calibrationScans + 1,
    };
  }
  return {
    ...profile,
    focalLengthPx: solvedFocalLengthPx,
    focalLengthSource: profile.focalLengthSource === "paper" ? "paper" : "height-solve",
    calibrationScans: profile.calibrationScans + 1,
  };
}
