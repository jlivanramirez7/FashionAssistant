// Live pose guidance for the capture screen (design doc sections 5 and 6/S5).
// PURE: normalized landmarks (unmirrored frame) in, one PoseHint out.
//
// Priority: no-person > framing (step-back / move-closer / center) >
// orientation (face-phone / turn-side / turn-back) > arms > hold-still > ok.
// The back view is accepted on ANY back signal (see backViewEvidence); the
// capture screen can also waive orientation (trustOrientation) after a while.

import { LM, type Landmark, type PoseHint, type ViewName } from "../types";

export interface PoseCheckOptions {
  /** Frame width / height. Landmarks are normalized per axis, so angles and
   *  ratios need it. Default 9/16 (portrait). */
  aspect?: number;
  /** Mean face visibility seen on the front step; a clear drop from it
   *  counts as evidence of a back view. */
  frontFaceVisibility?: number;
  /** Skip the which-way-am-I-facing tests (back: face / mirroring, side:
   *  which shoulder). Width checks still apply. The capture screen sets this
   *  when the user has been stuck on the orientation hint for a while: the
   *  live model is unreliable at telling front from back. */
  trustOrientation?: boolean;
}

export const POSE_THRESHOLDS = {
  /** Mean visibility of shoulders + hips below which there is no person. */
  minBodyVisibility: 0.3,
  /** Central-80% frame window for the head, torso and legs. */
  margin: 0.1,
  /** Wrists only need to stay this far inside the frame edge: in a 9:16
   *  portrait frame an A-pose at ~70% body height puts them at x ~ 0.08/0.92. */
  wristMargin: 0.02,
  /** Hip-centre offset from 0.5 that counts as off-centre. */
  centerTolerance: 0.05,
  /** Head-top to feet span as a fraction of frame height (target ~0.7). */
  minBodyFraction: 0.6,
  maxBodyFraction: 0.82,
  /** Shoulder width / torso length (true proportions): frontal >= this. */
  frontalRatio: 0.45,
  /** ... and side-on <= this. */
  sideRatio: 0.3,
  /** Mean face-landmark visibility separating "face visible" from not. */
  faceVisible: 0.5,
  /** A-pose arm angle from vertical, degrees. */
  armMinDeg: 30,
  armMaxDeg: 60,
  /** Side view: arms relaxed means below this angle. */
  sideArmMaxDeg: 30,
  /** Back view: face visibility this far below the front step's counts as turned away. */
  faceDropFromFront: 0.15,
  /** Back view: nose this much deeper than the shoulder midpoint (MediaPipe z, x-scaled). */
  noseBehindShoulders: 0.02,
  /** Max landmark motion over the history window, fraction of frame height.
   *  The lite model jitters a few mm at 2-3 m, so this cannot be too tight. */
  stillTolerance: 0.022,
} as const;

const FACE = [LM.nose, 2, 5, LM.mouthLeft, LM.mouthRight];
const MOTION_POINTS = [
  LM.nose, LM.leftShoulder, LM.rightShoulder, LM.leftWrist, LM.rightWrist,
  LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle,
];
const FRAMING_POINTS = [
  LM.nose, LM.leftShoulder, LM.rightShoulder,
  LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle,
];

function vis(l: Landmark | undefined): number {
  return l && Number.isFinite(l.visibility) ? l.visibility : 0;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function faceVisibility(lm: Landmark[]): number {
  return mean(FACE.map((i) => vis(lm[i])));
}

/** Shoulder width / torso length in true (aspect-corrected) proportions. */
export function shoulderWidthRatio(lm: Landmark[], aspect = 9 / 16): number {
  const ls = lm[LM.leftShoulder], rs = lm[LM.rightShoulder];
  const lh = lm[LM.leftHip], rh = lm[LM.rightHip];
  const sw = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  const smx = (ls.x + rs.x) / 2, smy = (ls.y + rs.y) / 2;
  const hmx = (lh.x + rh.x) / 2, hmy = (lh.y + rh.y) / 2;
  const torso = Math.hypot((smx - hmx) * aspect, smy - hmy);
  return torso > 0 ? sw / torso : 0;
}

/** Angle of the shoulder->wrist line from straight down, degrees (0 = hanging, 90 = horizontal). */
export function armAngleDeg(lm: Landmark[], side: "left" | "right", aspect = 9 / 16): number {
  const s = lm[side === "left" ? LM.leftShoulder : LM.rightShoulder];
  const w = lm[side === "left" ? LM.leftWrist : LM.rightWrist];
  const dx = (w.x - s.x) * aspect;
  const dy = w.y - s.y;
  return (Math.atan2(Math.abs(dx), dy) * 180) / Math.PI;
}

/** Estimated head top (normalized y): ~0.6x the nose-to-shoulder drop above the nose. */
export function headTopY(lm: Landmark[]): number {
  const nose = lm[LM.nose];
  const sy = (lm[LM.leftShoulder].y + lm[LM.rightShoulder].y) / 2;
  return nose.y - 0.6 * Math.max(0, sy - nose.y);
}

/** Lowest foot point (normalized y). */
export function feetY(lm: Landmark[]): number {
  return Math.max(
    lm[LM.leftAnkle].y, lm[LM.rightAnkle].y,
    lm[LM.leftHeel]?.y ?? -Infinity, lm[LM.rightHeel]?.y ?? -Infinity,
  );
}

/** Head-top to feet span as a fraction of the frame height. */
export function bodyHeightFraction(lm: Landmark[]): number {
  return feetY(lm) - headTopY(lm);
}

/** Max displacement (fraction of frame height) of key points between `lm` and any frame in `history`. */
export function maxMotion(lm: Landmark[], history: Landmark[][], aspect = 9 / 16): number {
  let m = 0;
  for (const h of history) {
    if (!h || h.length < 33) continue;
    for (const i of MOTION_POINTS) {
      const d = Math.hypot((lm[i].x - h[i].x) * aspect, lm[i].y - h[i].y);
      if (d > m) m = d;
    }
  }
  return m;
}

function isFiniteLm(l: Landmark | undefined): boolean {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y);
}

function framingHint(lm: Landmark[], aspect: number): PoseHint | null {
  const T = POSE_THRESHOLDS;
  const m = T.margin;
  const top = headTopY(lm);
  const feet = feetY(lm);
  const frac = feet - top;
  // Too big, or head / feet outside the central window vertically: stepping
  // back shrinks the body toward the horizon line.
  if (frac > T.maxBodyFraction || lm[LM.nose].y < m || feet > 1 - m || top < 0) return "step-back";
  if (frac < T.minBodyFraction) return "move-closer";
  const hipX = (lm[LM.leftHip].x + lm[LM.rightHip].x) / 2;
  const offCentre = Math.abs(hipX - 0.5) > T.centerTolerance;
  let x0 = Infinity, x1 = -Infinity;
  for (const i of FRAMING_POINTS) {
    x0 = Math.min(x0, lm[i].x);
    x1 = Math.max(x1, lm[i].x);
  }
  if (x0 < m || x1 > 1 - m) return offCentre ? "center" : "step-back";
  const wm = T.wristMargin;
  const wx = [lm[LM.leftWrist].x, lm[LM.rightWrist].x];
  // Arms raised too far are an arm problem (arms-down), not a framing one.
  const armsTooHigh = armAngleDeg(lm, "left", aspect) > T.armMaxDeg || armAngleDeg(lm, "right", aspect) > T.armMaxDeg;
  if (!armsTooHigh && wx.some((x) => x < wm || x > 1 - wm)) return offCentre ? "center" : "step-back";
  // Clearly off-centre even though everything fits.
  if (Math.abs(hipX - 0.5) > 2 * T.centerTolerance) return "center";
  return null;
}

/**
 * Any one signal that the user has their back to the camera. MediaPipe
 * keeps predicting face landmarks from behind, often with high visibility,
 * so face visibility alone is not enough:
 * - face visibility low (absolute, or clearly below the front step's);
 * - shoulders mirrored: the user's left shoulder on image left (unmirrored
 *   frame) means we see their back;
 * - nose deeper than the shoulders (z grows away from the camera).
 */
export function backViewEvidence(lm: Landmark[], frontFaceVisibility?: number): boolean {
  const T = POSE_THRESHOLDS;
  const face = faceVisibility(lm);
  if (face < T.faceVisible) return true;
  if (frontFaceVisibility !== undefined && face < frontFaceVisibility - T.faceDropFromFront) return true;
  const ls = lm[LM.leftShoulder], rs = lm[LM.rightShoulder];
  if (ls.x < rs.x) return true;
  const nz = lm[LM.nose].z, sz = (ls.z + rs.z) / 2;
  if (Number.isFinite(nz) && Number.isFinite(sz) && nz - sz > T.noseBehindShoulders) return true;
  return false;
}

function armsHint(lm: Landmark[], aspect: number): PoseHint | null {
  const T = POSE_THRESHOLDS;
  const l = armAngleDeg(lm, "left", aspect);
  const r = armAngleDeg(lm, "right", aspect);
  if (l < T.armMinDeg || r < T.armMinDeg) return "arms-out";
  if (l > T.armMaxDeg || r > T.armMaxDeg) return "arms-down";
  return null;
}

/**
 * Live guidance hint for one capture step.
 * @param history recent landmark sets (any order, e.g. the last ~1 s); the
 *   pose must not have moved more than POSE_THRESHOLDS.stillTolerance
 *   against any of them. Omit or pass [] to skip the stillness check.
 */
export function checkPose(
  view: ViewName,
  landmarks: Landmark[] | null,
  history?: Landmark[][],
  opts: PoseCheckOptions = {},
): PoseHint {
  const T = POSE_THRESHOLDS;
  const aspect = opts.aspect ?? 9 / 16;
  const lm = landmarks;
  if (!lm || lm.length < 33) return "no-person";
  const core = [LM.nose, LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip, LM.leftAnkle, LM.rightAnkle, LM.leftWrist, LM.rightWrist];
  if (!core.every((i) => isFiniteLm(lm[i]))) return "no-person";
  const bodyVis = mean([LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip].map((i) => vis(lm[i])));
  if (bodyVis < T.minBodyVisibility) return "no-person";

  const framing = framingHint(lm, aspect);
  if (framing) return framing;

  const ratio = shoulderWidthRatio(lm, aspect);
  const face = faceVisibility(lm);
  if (view === "front") {
    if (ratio < T.frontalRatio || face < T.faceVisible) return "face-phone";
    const arms = armsHint(lm, aspect);
    if (arms) return arms;
  } else if (view === "back") {
    if (ratio < T.frontalRatio) return "turn-back";
    if (!opts.trustOrientation && !backViewEvidence(lm, opts.frontFaceVisibility)) return "turn-back";
    const arms = armsHint(lm, aspect);
    if (arms) return arms;
  } else {
    if (ratio > T.sideRatio) return "turn-side";
    // Right shoulder toward the phone => the user faces image-right in the
    // unmirrored frame (nose ahead of the shoulders), and the right shoulder
    // is the nearer one (smaller z). Use the nose offset when it is clear,
    // z otherwise.
    const ls = lm[LM.leftShoulder], rs = lm[LM.rightShoulder];
    const noseDx = (lm[LM.nose].x - (ls.x + rs.x) / 2) * aspect;
    const rightToPhone = Math.abs(noseDx) > 0.005 ? noseDx > 0 : rs.z < ls.z;
    if (!rightToPhone && !opts.trustOrientation) return "turn-side";
    const l = armAngleDeg(lm, "left", aspect);
    const r = armAngleDeg(lm, "right", aspect);
    if (l > T.sideArmMaxDeg || r > T.sideArmMaxDeg) return "arms-down";
  }

  if (history && history.length > 0 && maxMotion(lm, history, aspect) > T.stillTolerance) return "hold-still";
  return "ok";
}
