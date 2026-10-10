// Region crop boxes for full-resolution segmentation (design doc section 7,
// "Segmentation resolution"). PURE: landmarks in, pixel boxes out.

import { LM, type Landmark } from "../types";

export interface CropBox {
  name: string;
  /** Top-left corner and size in full-frame PIXELS (integers, clamped to the frame). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Padding per region as a fraction of the torso length (shoulder-mid to hip-mid) in px. */
export const CROP_PAD = {
  head: 0.25,
  neckShoulders: 0.25,
  torso: 0.25,
  arm: 0.25,
  leg: 0.3,
} as const;

/** Smallest crop side kept, in px. */
const MIN_SIDE = 8;

interface Pt {
  x: number;
  y: number;
}

function usable(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

function boxAround(name: string, pts: Pt[], pad: number, width: number, height: number): CropBox | null {
  if (pts.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const bx0 = Math.max(0, Math.floor(x0 - pad));
  const by0 = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(width, Math.ceil(x1 + pad));
  const by1 = Math.min(height, Math.ceil(y1 + pad));
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (w < MIN_SIDE || h < MIN_SIDE) return null;
  return { name, x: bx0, y: by0, w, h };
}

/** The whole frame as a single crop (fallback when landmarks are missing). */
export function fullFrameCrop(width: number, height: number): CropBox {
  return { name: "full", x: 0, y: 0, w: width, h: height };
}

/**
 * Padded crop boxes per body region: head, neck/shoulders, torso, each arm,
 * each leg (feet included). Falls back to one full-frame crop when the
 * landmarks are missing or degenerate.
 */
export function regionCrops(landmarks: Landmark[] | null | undefined, width: number, height: number): CropBox[] {
  if (!landmarks || landmarks.length < 33) return [fullFrameCrop(width, height)];
  const px = (i: number): Pt | null => {
    const l = landmarks[i];
    return usable(l) ? { x: l.x * width, y: l.y * height } : null;
  };
  const pts = (idx: number[]): Pt[] => idx.map(px).filter((p): p is Pt => p !== null);

  const ls = px(LM.leftShoulder), rs = px(LM.rightShoulder);
  const lh = px(LM.leftHip), rh = px(LM.rightHip);
  if (!ls || !rs || !lh || !rh) return [fullFrameCrop(width, height)];
  const sm = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hm = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const T = Math.hypot(sm.x - hm.x, sm.y - hm.y);
  if (!(T > 4)) return [fullFrameCrop(width, height)];

  // Head: face landmarks plus an estimated head top (vertex is ~0.6x the
  // nose-to-shoulder drop above the nose; at least 0.25 T).
  const headPts = pts([LM.nose, 2, 5, LM.leftEar, LM.rightEar, LM.mouthLeft, LM.mouthRight]);
  const nose = px(LM.nose);
  if (nose) {
    const up = Math.max(0.6 * (sm.y - nose.y), 0.25 * T);
    headPts.push({ x: nose.x, y: nose.y - up });
  }

  const regions: [string, Pt[], number][] = [
    ["head", headPts, CROP_PAD.head],
    ["neckShoulders", pts([LM.mouthLeft, LM.mouthRight, LM.leftShoulder, LM.rightShoulder]), CROP_PAD.neckShoulders],
    ["torso", pts([LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip]), CROP_PAD.torso],
    ["leftArm", pts([LM.leftShoulder, LM.leftElbow, LM.leftWrist, 17, 19, 21]), CROP_PAD.arm],
    ["rightArm", pts([LM.rightShoulder, LM.rightElbow, LM.rightWrist, 18, 20, 22]), CROP_PAD.arm],
    ["leftLeg", pts([LM.leftHip, LM.leftKnee, LM.leftAnkle, LM.leftHeel, LM.leftFootIndex]), CROP_PAD.leg],
    ["rightLeg", pts([LM.rightHip, LM.rightKnee, LM.rightAnkle, LM.rightHeel, LM.rightFootIndex]), CROP_PAD.leg],
  ];
  const out: CropBox[] = [];
  for (const [name, p, pad] of regions) {
    const b = boxAround(name, p, pad * T, width, height);
    if (b) out.push(b);
  }
  return out.length > 0 ? out : [fullFrameCrop(width, height)];
}
