// QA ground-truth scene generator (independent of team code).
// World: camera lens at (0, h, 0); Y up; Z horizontal toward the user;
// X to the image's right. Optical axis raised phi above horizontal.
// Image v grows downward; frames are UNMIRRORED. Matches design doc
// section 4: alpha = atan((v - cy)/fy) - phi, d = h / tan(alpha).
import { LM, type DeviceProfile, type Landmark, type PersonMask, type ViewName } from "../../src/types";

export interface SceneCam {
  width: number;
  height: number;
  f: number; // fx = fy
  thetaDeg: number; // tilt from flat
  lensOffsetCm: number;
}

export function lensHeight(c: SceneCam): number {
  return c.lensOffsetCm * Math.sin((c.thetaDeg * Math.PI) / 180);
}

function phi(c: SceneCam): number {
  return ((90 - c.thetaDeg) * Math.PI) / 180;
}

/** Project world point (X, Y, Z) cm to pixel (u, v). */
export function project(c: SceneCam, X: number, Y: number, Z: number): { u: number; v: number } {
  const p = phi(c);
  const h = lensHeight(c);
  const dx = X, dy = Y - h, dz = Z;
  const fwd = dy * Math.sin(p) + dz * Math.cos(p);
  const up = dy * Math.cos(p) - dz * Math.sin(p);
  return { u: c.width / 2 + (c.f * dx) / fwd, v: c.height / 2 - (c.f * up) / fwd };
}

/** Back-project pixel (u, v) onto the vertical plane Z = d. */
export function unprojectToPlane(c: SceneCam, u: number, v: number, d: number): { X: number; Y: number } {
  const p = phi(c);
  const h = lensHeight(c);
  const xn = (u - c.width / 2) / c.f;
  const yn = (v - c.height / 2) / c.f;
  // dir = R*xn + U*(-yn) + F, R=(1,0,0) U=(0,cos p,-sin p) F=(0,sin p,cos p)
  const dX = xn;
  const dY = -yn * Math.cos(p) + Math.sin(p);
  const dZ = yn * Math.sin(p) + Math.cos(p);
  const t = d / dZ;
  return { X: t * dX, Y: h + t * dY };
}

/** W3C accelerationIncludingGravity for a phone leaning back theta from flat, rolled r in-plane. */
export function gravityFor(thetaDeg: number, rollDeg = 0, g = 9.81): [number, number, number] {
  const t = (thetaDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  return [g * Math.sin(t) * Math.sin(r), g * Math.sin(t) * Math.cos(r), g * Math.cos(t)];
}

export function makeProfile(c: SceneCam, extra: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    deviceId: "qa-device",
    label: "QA",
    deviceModelGuess: "QA synthetic",
    modelSource: "generic",
    screen: { width: 390, height: 844, devicePixelRatio: 3 },
    lensOffsetCm: c.lensOffsetCm,
    lensOffsetSource: "generic",
    front35mmEqMm: 26,
    focalLengthPx: c.f,
    focalLengthSource: "spec",
    captureWidth: c.width,
    captureHeight: c.height,
    calibrationScans: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------- flat "cardboard" person

/** Ground-truth dimensions of the synthetic person (cm). */
export const BODY = {
  heightCm: 175,
  torsoWidth: 34, // front/back
  torsoDepth: 24, // side
  neckWidth: 12,
  neckDepth: 12,
  crotchY: 82,
  shoulderY: 144,
  hipY: 92,
  kneeY: 48,
  ankleY: 8,
  legWidth: 14,
  legDepth: 14,
};

/** Ramanujan ellipse circumference from full width and depth. */
export function ramanujan(w: number, d: number): number {
  const a = w / 2, b = d / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

type Pt = [number, number]; // (X, Y) in the body plane

/** Landmark positions (X, Y) in the plane for a view. Unmirrored: for a person
 * FACING the camera, their LEFT side is at +X (image right). */
function landmarkPoints(view: ViewName): Map<number, Pt> {
  const B = BODY;
  const m = new Map<number, Pt>();
  if (view === "side") {
    // Right shoulder faces the phone: both sides project near X = 0.
    const s = (i: number, y: number, x = 0) => m.set(i, [x, y]);
    s(LM.nose, 163, -9); s(LM.leftEar, 165, 0); s(LM.rightEar, 165, 0);
    s(LM.mouthLeft, 159, -8); s(LM.mouthRight, 159, -8);
    s(LM.leftShoulder, B.shoulderY); s(LM.rightShoulder, B.shoulderY);
    s(LM.leftElbow, 118); s(LM.rightElbow, 118);
    s(LM.leftWrist, 92); s(LM.rightWrist, 92);
    s(LM.leftHip, B.hipY); s(LM.rightHip, B.hipY);
    s(LM.leftKnee, B.kneeY); s(LM.rightKnee, B.kneeY);
    s(LM.leftAnkle, B.ankleY); s(LM.rightAnkle, B.ankleY);
    // Heel and foot index are floor-contact points (flat-footed stance), orchestrator convention.
    s(LM.leftHeel, 0, 5); s(LM.rightHeel, 0, 5);
    s(LM.leftFootIndex, 0, -16); s(LM.rightFootIndex, 0, -16);
    return m;
  }
  const sgn = view === "front" ? 1 : -1; // back view: left side at -X
  const pair = (l: number, r: number, x: number, y: number) => {
    m.set(l, [sgn * x, y]);
    m.set(r, [-sgn * x, y]);
  };
  m.set(LM.nose, [0, 163]);
  pair(LM.leftEar, LM.rightEar, 7, 165);
  pair(LM.mouthLeft, LM.mouthRight, 2.5, 159);
  pair(LM.leftShoulder, LM.rightShoulder, 19, B.shoulderY);
  // A-pose: arms 45 deg out. Upper arm 30 cm, forearm 26 cm.
  const k = Math.SQRT1_2;
  pair(LM.leftElbow, LM.rightElbow, 19 + 30 * k, B.shoulderY - 30 * k);
  pair(LM.leftWrist, LM.rightWrist, 19 + 56 * k, B.shoulderY - 56 * k);
  pair(LM.leftHip, LM.rightHip, 9, B.hipY);
  pair(LM.leftKnee, LM.rightKnee, 9, B.kneeY);
  pair(LM.leftAnkle, LM.rightAnkle, 9, B.ankleY);
  pair(LM.leftHeel, LM.rightHeel, 9, 0); // floor contact
  pair(LM.leftFootIndex, LM.rightFootIndex, 11, 0); // floor contact
  return m;
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

/** Is plane point (X, Y) inside the synthetic body for this view? */
function inside(view: ViewName, X: number, Y: number, headTopY: number = BODY.heightCm): boolean {
  const B = BODY;
  if (Y < 0 || Y > headTopY) return false;
  if (view === "side") {
    if (Y >= 152) return Math.abs(X + 1) <= 10; // head
    if (Y >= B.shoulderY) return Math.abs(X) <= B.neckDepth / 2; // neck
    if (Y >= B.crotchY) return Math.abs(X) <= B.torsoDepth / 2; // torso (arms hidden)
    if (Y <= 4) return X >= -17 && X <= 6; // feet pointing toward -X
    return Math.abs(X) <= B.legDepth / 2; // legs overlap
  }
  // front / back (symmetric)
  const ax = Math.abs(X);
  if (Y >= 152) return ax <= 8; // head
  if (Y >= B.shoulderY) {
    if (ax <= B.neckWidth / 2) return true;
  }
  if (Y >= B.crotchY && Y < B.shoulderY && ax <= B.torsoWidth / 2) return true;
  // arms (thickness 9 cm upper, 7 cm forearm), from the shoulder joint
  const k = Math.SQRT1_2;
  const sh: Pt = [19, B.shoulderY], el: Pt = [19 + 30 * k, B.shoulderY - 30 * k], wr: Pt = [19 + 56 * k, B.shoulderY - 56 * k];
  if (distToSegment(ax, Y, sh, el) <= 4.5 || distToSegment(ax, Y, el, wr) <= 3.5) return true;
  // shoulder cap rounding the torso top into the arm
  if (Y >= B.shoulderY - 6 && Y <= B.shoulderY + 3 && ax <= 21) return true;
  if (Y < B.crotchY) return ax >= 2 && ax <= 2 + B.legWidth; // two legs with a gap
  return false;
}

/**
 * A real head is a 3D ellipsoid (vertical semi-axis 0.066 H; semi-axis along the
 * view ray 0.057 H front/back, 0.043 H side), crown at H, centred on the plane Z = d.
 * A floor camera sees the TANGENT ray over the skull, which crosses the plane above
 * the crown. Returns that silhouette-top height on the plane, found numerically
 * (max ray slope over the ellipse outline) - independent of team C's closed form.
 */
export function headSilhouetteTopY(c: SceneCam, view: ViewName, d: number, heightCm = BODY.heightCm): number {
  const h = lensHeight(c);
  const cv = 0.066 * heightCm;
  const b = (view === "side" ? 0.043 : 0.057) * heightCm;
  const yc = heightCm - cv;
  let best = -Infinity;
  let bestT = 0;
  const slope = (t: number) => (yc + cv * Math.sin(t) - h) / (d + b * Math.cos(t));
  for (let i = 0; i <= 3600; i++) {
    const t = (i / 3600) * 2 * Math.PI;
    const s = slope(t);
    if (s > best) { best = s; bestT = t; }
  }
  // golden-section refine around the best grid point
  let lo = bestT - 0.01, hi = bestT + 0.01;
  for (let k = 0; k < 100; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (slope(m1) < slope(m2)) lo = m1; else hi = m2;
  }
  return h + d * slope((lo + hi) / 2);
}

export interface ViewScene {
  view: ViewName;
  landmarks: Landmark[]; // NORMALIZED 0..1 (as MediaPipe returns)
  mask: PersonMask; // full-frame pixels
  vFeet: number;
  vHead: number;
}

/** Render one view of the cardboard person standing at distance d. */
export function renderView(c: SceneCam, view: ViewName, d: number): ViewScene {
  const pts = landmarkPoints(view);
  const landmarks: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    const p = pts.get(i) ?? pts.get(LM.nose)!; // unused indices: park on the nose
    const { u, v } = project(c, p[0], p[1], d);
    landmarks.push({ x: u / c.width, y: v / c.height, z: 0, visibility: pts.has(i) ? 0.99 : 0.5 });
  }
  const headTopY = headSilhouetteTopY(c, view, d);
  const data = new Uint8Array(c.width * c.height);
  for (let v = 0; v < c.height; v++) {
    for (let u = 0; u < c.width; u++) {
      const q = unprojectToPlane(c, u + 0.5, v + 0.5, d);
      if (inside(view, q.X, q.Y, headTopY)) data[v * c.width + u] = 1;
    }
  }
  return {
    view,
    landmarks,
    mask: { width: c.width, height: c.height, data },
    vFeet: project(c, 0, 0, d).v,
    vHead: project(c, 0, headTopY, d).v, // silhouette top of a real (3D) head
  };
}
