// Vision API (team D, docs/CONTRACTS.md). MediaPipe wrappers are thin; the
// logic lives in the pure helpers (crops, compose, edgeRefine, quality,
// poseCheck).

import type { Landmark, QualityScore } from "../types";
import { frameQualityFrom } from "./quality";
import { config, ensureHeavy, ensureLive, ensureSegmenter } from "./runtime";

export { MODEL_VERSIONS, delegates as visionDelegates, closeAll as closeVision } from "./runtime";
export { detectPoseLive, detectPoseHeavy } from "./pose";
export { segmentPerson } from "./segmentation";
export { checkPose, type PoseCheckOptions } from "./poseCheck";
export { regionCrops, type CropBox } from "./crops";

export interface InitVisionOptions {
  wasmBase?: string;
  modelBase?: string;
  live?: boolean;
  heavy?: boolean;
  segmenter?: boolean;
}

/**
 * Loads the MediaPipe runtime and models (GPU delegate, CPU fallback).
 * Defaults: wasmBase "/wasm", modelBase "/models". When none of live / heavy /
 * segmenter is given, all three are loaded; otherwise only those set true.
 * Safe to call repeatedly (already-loaded tasks are reused). detectPoseHeavy
 * and segmentPerson also load their model on first use; detectPoseLive does
 * not (it is synchronous) and returns null until { live: true } is loaded.
 */
export async function initVision(opts: InitVisionOptions = {}): Promise<void> {
  if (opts.wasmBase) config.wasmBase = opts.wasmBase;
  if (opts.modelBase) config.modelBase = opts.modelBase;
  const none = opts.live === undefined && opts.heavy === undefined && opts.segmenter === undefined;
  const jobs: Promise<unknown>[] = [];
  if (none || opts.live) jobs.push(ensureLive());
  if (none || opts.heavy) jobs.push(ensureHeavy());
  if (none || opts.segmenter) jobs.push(ensureSegmenter());
  await Promise.all(jobs);
}

/** Sharpness (Laplacian variance inside the person box) + in-frame check. */
export function frameQuality(image: ImageData, landmarks: Landmark[] | null): QualityScore {
  return frameQualityFrom(image, landmarks);
}
