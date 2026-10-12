// Pose landmark wrappers (browser only).
//   live:  PoseLandmarker (lite, VIDEO mode) .detectForVideo(video, timestampMs)
//   heavy: PoseLandmarker (heavy, IMAGE mode) .detect(image)
// Both use the synchronous overloads, which return a PoseLandmarkerResult that
// we close() after copying the landmarks. The heavy model also returns a
// whole-body segmentation mask, kept (downsampled) per frame for segmentPerson.

import type { NormalizedLandmark, PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "../types";
import type { CropProb } from "./compose";
import { BLANK_BODY_MAX, maxValue } from "./compose";
import { ensureHeavy, switchToCpu, tasks } from "./runtime";

/** PURE: first pose of a result as plain Landmarks (x, y normalized). */
export function toLandmarks(poses: NormalizedLandmark[][] | undefined): Landmark[] | null {
  const p = poses?.[0];
  if (!p || p.length === 0) return null;
  return p.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 }));
}

function read(result: PoseLandmarkerResult): Landmark[] | null {
  try {
    return toLandmarks(result.landmarks);
  } finally {
    result.close();
  }
}

/** Body masks are stored at most this many px on the long side. */
const BODY_MASK_MAX = 512;
const bodyMasks = new WeakMap<object, CropProb>();

/** PURE: downsample a full-frame probability map (nearest) to at most maxLong px on the long side. */
export function downsampleProb(prob: Float32Array, w: number, h: number, maxLong = BODY_MASK_MAX): { w: number; h: number; prob: Float32Array } {
  const s = Math.min(1, maxLong / Math.max(w, h));
  if (s === 1) return { w, h, prob: Float32Array.from(prob) };
  const ow = Math.max(1, Math.round(w * s));
  const oh = Math.max(1, Math.round(h * s));
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / oh));
    for (let x = 0; x < ow; x++) out[y * ow + x] = prob[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / ow))];
  }
  return { w: ow, h: oh, prob: out };
}

/** Whole-body mask the heavy model produced for this frame (full-frame box), if any. */
export function bodyMaskFor(image: object): CropProb | null {
  return bodyMasks.get(image) ?? null;
}

let lastVideoTs = -1;

/**
 * Lite model on the current video frame. Returns null when the live model is
 * not loaded yet, the video has no frame, or no person is found. Timestamps
 * are forced to increase (VIDEO mode requires it).
 */
export function detectPoseLive(video: HTMLVideoElement, timestampMs: number): Landmark[] | null {
  const lm = tasks.live;
  if (!lm || video.readyState < 2 || video.videoWidth === 0) return null;
  const ts = timestampMs > lastVideoTs ? timestampMs : lastVideoTs + 1;
  lastVideoTs = ts;
  try {
    return read(lm.detectForVideo(video, ts));
  } catch (err) {
    console.warn("[vision] live pose failed", err);
    return null;
  }
}

/** Heavy model on one full-resolution frame (loads the model on first use). */
export async function detectPoseHeavy(image: ImageBitmap | ImageData): Promise<Landmark[] | null> {
  for (let attempt = 0; ; attempt++) {
    const lm = await ensureHeavy();
    const result = lm.detect(image);
    let blank = false;
    try {
      const m = result.segmentationMasks?.[0];
      if (m && m.width > 0 && m.height > 0) {
        const d = downsampleProb(m.getAsFloat32Array(), m.width, m.height);
        const maxProb = maxValue(d.prob);
        blank = !!result.landmarks?.[0]?.length && maxProb < BLANK_BODY_MAX;
        bodyMasks.set(image, { x: 0, y: 0, w: image.width, h: image.height, maskWidth: d.w, maskHeight: d.h, prob: d.prob, maxProb });
      }
    } catch (err) {
      console.warn("[vision] body mask unavailable", err);
    }
    const landmarks = read(result);
    // Person found but an empty body mask: the GPU read the mask back blank.
    if (blank && attempt === 0 && (await switchToCpu("heavy", "body mask blank"))) continue;
    return landmarks;
  }
}
