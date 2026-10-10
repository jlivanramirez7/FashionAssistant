// Frame quality (design doc sections 5 step 9 and 7): sharpness via the
// variance of the Laplacian on a grayscale buffer, plus an in-frame check.
// PURE: works on plain RGBA / gray buffers (ImageData-shaped objects).

import { LM, type Landmark, type QualityScore } from "../types";

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Laplacian variance at which sharpness = 0.5 (gray 0..255). Tunable with real captures. */
export const SHARPNESS_HALF_VARIANCE = 100;
/** Below this sharpness (Laplacian variance < ~43) a frame is "blurry". Needs calibration on real captures. */
export const BLUR_THRESHOLD = 0.3;
/** Central-80% frame margin (fraction of width/height on each side). */
export const FRAME_MARGIN = 0.1;
/** Slack added to the margin for the post-capture check, so frames accepted live are not rejected for tiny drift. */
export const QUALITY_MARGIN_SLACK = 0.03;

/** Landmarks that must be inside the central window for measurement. */
export const REQUIRED_LANDMARKS: readonly number[] = [
  LM.nose,
  LM.leftShoulder, LM.rightShoulder,
  LM.leftHip, LM.rightHip,
  LM.leftAnkle, LM.rightAnkle,
];
/** Wrists only need to be inside the frame (an A-pose at ~70% height reaches x ~ 0.08 / 0.92 in 9:16). */
export const EDGE_LANDMARKS: readonly number[] = [LM.leftWrist, LM.rightWrist];
export const EDGE_MARGIN = 0.01;

/** ITU-R BT.601 luma, rounded to 0..255. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114 + 500) / 1000;
  }
  return out;
}

/** Variance of the 4-neighbour Laplacian over the ROI (whole image by default). */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number, roi?: Roi): number {
  const x0 = Math.max(1, roi ? Math.floor(roi.x) : 1);
  const y0 = Math.max(1, roi ? Math.floor(roi.y) : 1);
  const x1 = Math.min(width - 1, roi ? Math.ceil(roi.x + roi.w) : width - 1);
  const y1 = Math.min(height - 1, roi ? Math.ceil(roi.y + roi.h) : height - 1);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/** Maps Laplacian variance to 0..1 (0.5 at SHARPNESS_HALF_VARIANCE). */
export function sharpnessScore(variance: number): number {
  if (!(variance > 0)) return 0;
  return variance / (variance + SHARPNESS_HALF_VARIANCE);
}

/** True when every required landmark is inside [margin, 1 - margin] on both axes. */
export function landmarksInFrame(
  landmarks: Landmark[] | null,
  margin = FRAME_MARGIN,
  required: readonly number[] = REQUIRED_LANDMARKS,
): boolean {
  if (!landmarks || landmarks.length < 33) return false;
  for (const i of required) {
    const l = landmarks[i];
    if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return false;
    if (l.x < margin || l.x > 1 - margin || l.y < margin || l.y > 1 - margin) return false;
  }
  return true;
}

/** Bounding box of all landmarks (padded 5% of the frame), clamped; null without landmarks. */
export function personRoi(landmarks: Landmark[] | null, width: number, height: number): Roi | null {
  if (!landmarks || landmarks.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of landmarks) {
    if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
    x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x); y1 = Math.max(y1, l.y);
  }
  if (!Number.isFinite(x0)) return null;
  const px0 = Math.max(0, Math.floor((x0 - 0.05) * width));
  const py0 = Math.max(0, Math.floor((y0 - 0.05) * height));
  const px1 = Math.min(width, Math.ceil((x1 + 0.05) * width));
  const py1 = Math.min(height, Math.ceil((y1 + 0.05) * height));
  if (px1 - px0 < 3 || py1 - py0 < 3) return null;
  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
}

/**
 * Quality of one captured frame. Sharpness is measured inside the person's
 * bounding box (a plain wall would otherwise dilute it); score is the
 * sharpness, halved when the person is not fully inside the frame.
 */
export function frameQualityFrom(image: RgbaImage, landmarks: Landmark[] | null): QualityScore {
  const { width, height } = image;
  if (!landmarks || landmarks.length < 33) {
    return { sharpness: 0, inFrame: false, score: 0, reason: "no-person" };
  }
  const gray = rgbaToGray(image.data, width, height);
  const roi = personRoi(landmarks, width, height) ?? undefined;
  const sharpness = sharpnessScore(laplacianVariance(gray, width, height, roi));
  const inFrame =
    landmarksInFrame(landmarks, FRAME_MARGIN - QUALITY_MARGIN_SLACK) &&
    landmarksInFrame(landmarks, EDGE_MARGIN, EDGE_LANDMARKS);
  const score = inFrame ? sharpness : sharpness * 0.5;
  const q: QualityScore = { sharpness, inFrame, score };
  if (!inFrame) q.reason = "out-of-frame";
  else if (sharpness < BLUR_THRESHOLD) q.reason = "blurry";
  return q;
}
