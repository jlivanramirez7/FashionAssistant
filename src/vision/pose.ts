// Pose landmark wrappers (browser only).
//   live:  PoseLandmarker (lite, VIDEO mode) .detectForVideo(video, timestampMs)
//   heavy: PoseLandmarker (heavy, IMAGE mode) .detect(image)
// Both use the synchronous overloads, which return a PoseLandmarkerResult that
// we close() after copying the landmarks (no segmentation masks requested).

import type { NormalizedLandmark, PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "../types";
import { ensureHeavy, tasks } from "./runtime";

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
  const lm = await ensureHeavy();
  return read(lm.detect(image));
}
