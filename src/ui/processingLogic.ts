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

/** PURE: overall progress 0..1 from (stage, fraction within stage). */
export function overallProgress(stage: ProgressStage, fraction: number): number {
  const i = Math.max(0, STAGE_ORDER.indexOf(stage));
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (i + f) / STAGE_ORDER.length;
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

/** PURE: device record to save after a scan (height-solve refines f_y). */
export function updatedProfile(profile: DeviceProfile, solvedFocalLengthPx: number | undefined): DeviceProfile {
  if (solvedFocalLengthPx === undefined || !Number.isFinite(solvedFocalLengthPx) || solvedFocalLengthPx <= 0) return profile;
  return {
    ...profile,
    focalLengthPx: solvedFocalLengthPx,
    focalLengthSource: profile.focalLengthSource === "paper" ? "paper" : "height-solve",
    calibrationScans: profile.calibrationScans + 1,
  };
}
