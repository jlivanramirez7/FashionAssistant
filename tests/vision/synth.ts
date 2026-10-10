// Synthetic pose landmarks for vision tests (normalized, unmirrored frame).
import type { Landmark, ViewName } from "../../src/types";

export interface BodyOpts {
  view?: ViewName;
  /** Horizontal centre (normalized x). */
  cx?: number;
  /** Head top (normalized y). */
  top?: number;
  /** Head-top-to-sole span as a fraction of frame height. */
  frac?: number;
  /** Arm angle from vertical in degrees (both arms). */
  armDeg?: number;
  leftArmDeg?: number;
  rightArmDeg?: number;
  aspect?: number;
  faceVis?: number;
  bodyVis?: number;
  /** Side view only: true = facing image-left (left shoulder to the phone). */
  wrongSide?: boolean;
}

export function makeBody(o: BodyOpts = {}): Landmark[] {
  const view = o.view ?? "front";
  const cx = o.cx ?? 0.5;
  const top = o.top ?? 0.15;
  const f = o.frac ?? 0.7;
  const a = o.aspect ?? 9 / 16;
  const faceVis = o.faceVis ?? (view === "back" ? 0.1 : 0.95);
  const bodyVis = o.bodyVis ?? 0.95;
  const armDeg = o.armDeg ?? (view === "side" ? 5 : 45);
  const lArm = o.leftArmDeg ?? armDeg;
  const rArm = o.rightArmDeg ?? armDeg;

  // Half-widths in height units; side view collapses them.
  const k = view === "side" ? 0.15 : 1;
  // Front: user's left appears at image right (+x). Back: mirrored.
  const sgn = view === "back" ? -1 : 1;
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({ x: cx, y: top + 0.5 * f, z: 0, visibility: bodyVis }));
  const set = (i: number, hx: number, hy: number, v = bodyVis, z = 0) => {
    lms[i] = { x: cx + (hx * f) / a, y: top + hy * f, z, visibility: v };
  };
  const side = view === "side";
  const faceDx = side ? (o.wrongSide ? -0.05 : 0.05) : 0;
  set(0, faceDx, 0.07, faceVis);
  for (const i of [1, 2, 3]) set(i, faceDx + sgn * k * 0.03, 0.06, faceVis);
  for (const i of [4, 5, 6]) set(i, faceDx - sgn * k * 0.03, 0.06, faceVis);
  set(7, faceDx + sgn * k * 0.06, 0.07, faceVis);
  set(8, faceDx - sgn * k * 0.06, 0.07, faceVis);
  set(9, faceDx + sgn * k * 0.02, 0.1, faceVis);
  set(10, faceDx - sgn * k * 0.02, 0.1, faceVis);
  // In the side view the right shoulder is nearer (smaller z) unless wrongSide.
  const zr = side ? (o.wrongSide ? 0.1 : -0.1) : 0;
  set(11, sgn * k * 0.11, 0.18, bodyVis, -zr);
  set(12, -sgn * k * 0.11, 0.18, bodyVis, zr);
  const arm = (si: number, ei: number, wi: number, hands: number[], dir: number, deg: number) => {
    const s = lms[si];
    const r = (deg * Math.PI) / 180;
    const ux = (dir * Math.sin(r)) / a, uy = Math.cos(r);
    lms[ei] = { x: s.x + 0.19 * f * ux, y: s.y + 0.19 * f * uy, z: 0, visibility: bodyVis };
    lms[wi] = { x: s.x + 0.34 * f * ux, y: s.y + 0.34 * f * uy, z: 0, visibility: bodyVis };
    for (const h of hands) lms[h] = { x: s.x + 0.37 * f * ux, y: s.y + 0.37 * f * uy, z: 0, visibility: bodyVis };
  };
  arm(11, 13, 15, [17, 19, 21], sgn, lArm);
  arm(12, 14, 16, [18, 20, 22], -sgn, rArm);
  set(23, sgn * k * 0.06, 0.48);
  set(24, -sgn * k * 0.06, 0.48);
  set(25, sgn * k * 0.06, 0.72);
  set(26, -sgn * k * 0.06, 0.72);
  set(27, sgn * k * 0.06, 0.95);
  set(28, -sgn * k * 0.06, 0.95);
  set(29, sgn * k * 0.06, 0.97);
  set(30, -sgn * k * 0.06, 0.97);
  set(31, sgn * k * 0.08, 0.98);
  set(32, -sgn * k * 0.08, 0.98);
  // Head-top estimate in checkPose is nose - 0.6*(shoulder - nose) = 0.07 - 0.066 ~ top.
  return lms;
}

export function jitter(lms: Landmark[], dx: number, dy: number): Landmark[] {
  return lms.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
}
