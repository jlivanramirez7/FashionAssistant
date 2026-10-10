// Measurements from per-view frames (design doc section 7, steps 5-9).
//
// For every frame we sample metric outline profiles on a height grid (torso width or
// depth, leg width, leg gap, arm separation). Frames of the front, side and back views
// are paired into tuples (frame i of each view, cycling shorter views); each tuple
// finds its own body levels and measures everything, so the frame-to-frame spread
// includes level-finding noise. Per key, tuples are averaged after dropping outliers.
import {
  LM,
  MEASUREMENT_SPECS,
  type CorrectionFactors,
  type Landmark,
  type MeasurementKey,
  type Measurements,
  type PersonMask,
  type RawMeasurements,
  type ScanInputs,
  type ViewName,
  type ViewPlane,
} from "../types";
import { rowAtColumn } from "../geometry/plane";
import { ellipseCircumference } from "./ellipse";
import { findLevels, type BodyLevels, type LevelInput, type LevelName } from "./levels";
import { chordThrough, maskAt, spanAtRow } from "./silhouette";

export interface FrameData {
  /** Landmarks with x, y in PIXELS (full frame). */
  landmarksPx: Landmark[];
  mask: PersonMask;
  plane: ViewPlane;
}

export interface ViewData {
  view: ViewName;
  frames: FrameData[];
}

export interface ComputeOptions {
  /** The device has a calibrated distortionK1: no lens-distortion uncertainty term. */
  hasDistortionK1?: boolean;
}

/** Grid step (cm) of the height profiles. */
export const PROFILE_STEP_CM = 0.25;
/** Landmarks below this visibility are ignored. */
export const MIN_VISIBILITY = 0.3;
/** Expected residual lens-distortion error as a fraction of the value (no distortionK1). */
export const DISTORTION_UNCERTAINTY_FRAC = 0.005;
/** Assumed depth/width ratio of the upper arm (front view sees only its width). */
export const BICEP_DEPTH_RATIO = 1.0;
/** Assumed other-axis/visible-chord ratio at the wrist (palms facing the thighs in A-pose). */
export const WRIST_DEPTH_RATIO = 1.3;

type Pt = { u: number; v: number };
type MPt = { x: number; y: number };

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function lmPx(f: FrameData, i: number): Pt | null {
  const l = f.landmarksPx[i];
  if (!l || !fin(l.x) || !fin(l.y)) return null;
  if (fin(l.visibility) && l.visibility < MIN_VISIBILITY) return null;
  return { u: l.x, v: l.y };
}

function midPt(a: Pt | null, b: Pt | null): Pt | null {
  if (a && b) return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
  return a ?? b;
}

/** Column at row v along a polyline of points (sorted by v); clamped beyond the ends. */
function chainU(chain: (Pt | null)[], v: number): number | null {
  const pts = chain.filter((p): p is Pt => p !== null).sort((a, b) => a.v - b.v);
  if (pts.length === 0) return null;
  if (v <= pts[0].v) return pts[0].u;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i].v) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = b.v - a.v > 1e-9 ? (v - a.v) / (b.v - a.v) : 0;
      return a.u + t * (b.u - a.u);
    }
  }
  return pts[pts.length - 1].u;
}

function metric(f: FrameData, u: number, v: number): MPt {
  const m = f.plane.toMetric(u, v);
  return { x: m.xCm, y: m.yCm };
}

const dist = (a: MPt, b: MPt) => Math.hypot(a.x - b.x, a.y - b.y);

// ------------------------------------------------------------------ per-frame model

interface FrameModel {
  f: FrameData;
  view: ViewName;
  torsoChain: (Pt | null)[];
  legL: (Pt | null)[];
  legR: (Pt | null)[];
  armL: [Pt | null, Pt | null, Pt | null];
  armR: [Pt | null, Pt | null, Pt | null];
  /** Metric height of a landmark (or mean of a pair). */
  y(i: number, j?: number): number | null;
  torsoCenterU(v: number): number;
  rowFor(y: number): number;
  torsoWidth(y: number): { width: number; v: number; u0: number; u1: number } | null;
  profile?: {
    torso: (number | null)[];
    leg: (number | null)[];
    gap: (boolean | null)[];
    arms: (boolean | null)[];
  };
}

function frameModel(f: FrameData, view: ViewName): FrameModel {
  const p = (i: number) => lmPx(f, i);
  const midSh = midPt(p(LM.leftShoulder), p(LM.rightShoulder));
  const midHip = midPt(p(LM.leftHip), p(LM.rightHip));
  const head = view === "side" ? null : p(LM.nose);
  const torsoChain = [head, midSh, midHip];
  const fallbackU = f.mask.width / 2;
  const m: FrameModel = {
    f,
    view,
    torsoChain,
    legL: [p(LM.leftHip), p(LM.leftKnee), p(LM.leftAnkle)],
    legR: [p(LM.rightHip), p(LM.rightKnee), p(LM.rightAnkle)],
    armL: [p(LM.leftShoulder), p(LM.leftElbow), p(LM.leftWrist)],
    armR: [p(LM.rightShoulder), p(LM.rightElbow), p(LM.rightWrist)],
    y(i: number, j?: number) {
      const a = p(i);
      const b = j === undefined ? null : p(j);
      const ys = [a, b].filter((q): q is Pt => q !== null).map((q) => metric(f, q.u, q.v).y);
      return ys.length ? ys.reduce((s, x) => s + x, 0) / ys.length : null;
    },
    torsoCenterU(v: number) {
      return chainU(torsoChain, v) ?? fallbackU;
    },
    rowFor(y: number) {
      const v0 = f.plane.rowForHeight(y);
      return rowAtColumn(f.plane, m.torsoCenterU(v0), y);
    },
    torsoWidth(y: number) {
      const v = m.rowFor(y);
      if (!fin(v)) return null;
      const s = spanAtRow(f.mask, v, m.torsoCenterU(v));
      if (!s) return null;
      const w = Math.abs(metric(f, s.u1, v).x - metric(f, s.u0, v).x);
      return { width: w, v, u0: s.u0, u1: s.u1 };
    },
  };
  return m;
}

function legWidthAtRow(m: FrameModel, v: number): number | null {
  const uL = chainU(m.legL, v);
  const uR = chainU(m.legR, v);
  const ws: number[] = [];
  for (const [u, other] of [[uL, uR], [uR, uL]] as const) {
    if (u === null) continue;
    const s = spanAtRow(m.f.mask, v, u);
    if (!s) continue;
    let w = Math.abs(metric(m.f, s.u1, v).x - metric(m.f, s.u0, v).x);
    if (other !== null && other >= s.u0 && other < s.u1) w /= 2; // legs touching: split
    ws.push(w);
  }
  return ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
}

function legGapAtRow(m: FrameModel, v: number): boolean | null {
  const uL = chainU(m.legL, v);
  const uR = chainU(m.legR, v);
  if (uL === null || uR === null) return null;
  const a = spanAtRow(m.f.mask, v, Math.min(uL, uR));
  const b = spanAtRow(m.f.mask, v, Math.max(uL, uR));
  if (!a || !b) return null;
  if (a.u0 === b.u0) return false;
  const c = (uL + uR) / 2;
  return !maskAt(m.f.mask, c, v) && a.u1 <= c && b.u0 >= c;
}

function armsSeparatedAtRow(m: FrameModel, v: number): boolean | null {
  const torso = spanAtRow(m.f.mask, v, m.torsoCenterU(v));
  if (!torso) return null;
  let any = false;
  for (const arm of [m.armL, m.armR]) {
    const [s, , w] = arm;
    if (!s || !w || v < s.v || v > w.v) continue;
    const u = chainU(arm, v);
    if (u === null) continue;
    any = true;
    const inside = u >= torso.u0 && u < torso.u1;
    if (inside || !maskAt(m.f.mask, u, v)) return false;
  }
  return any ? true : null;
}

function ensureProfile(m: FrameModel, heightCm: number): NonNullable<FrameModel["profile"]> {
  if (m.profile) return m.profile;
  const n = Math.ceil((heightCm * 1.05) / PROFILE_STEP_CM) + 1;
  const torso: (number | null)[] = new Array(n).fill(null);
  const leg: (number | null)[] = new Array(n).fill(null);
  const gap: (boolean | null)[] = new Array(n).fill(null);
  const arms: (boolean | null)[] = new Array(n).fill(null);
  const isSide = m.view === "side";
  for (let i = 0; i < n; i++) {
    const y = i * PROFILE_STEP_CM;
    const v = m.rowFor(y);
    if (!fin(v) || v < 0 || v >= m.f.mask.height) continue;
    const s = spanAtRow(m.f.mask, v, m.torsoCenterU(v));
    if (s) torso[i] = Math.abs(metric(m.f, s.u1, v).x - metric(m.f, s.u0, v).x);
    if (!isSide) {
      leg[i] = legWidthAtRow(m, v);
      gap[i] = legGapAtRow(m, v);
      arms[i] = armsSeparatedAtRow(m, v);
    } else {
      // side view: legs overlap; depth of the run on the leg axis
      const lu = chainU(m.legL, v) ?? chainU(m.legR, v);
      const ru = chainU(m.legR, v) ?? lu;
      if (lu !== null && ru !== null) {
        const ls = spanAtRow(m.f.mask, v, (lu + ru) / 2);
        if (ls) leg[i] = Math.abs(metric(m.f, ls.u1, v).x - metric(m.f, ls.u0, v).x);
      }
    }
  }
  m.profile = { torso, leg, gap, arms };
  return m.profile;
}

/** Depth of the side-view leg run at height y. */
function sideLegDepth(m: FrameModel, y: number): number | null {
  const v = m.rowFor(y);
  const lu = chainU(m.legL, v) ?? chainU(m.legR, v);
  const ru = chainU(m.legR, v) ?? lu;
  if (lu === null || ru === null) return null;
  const s = spanAtRow(m.f.mask, v, (lu + ru) / 2);
  return s ? Math.abs(metric(m.f, s.u1, v).x - metric(m.f, s.u0, v).x) : null;
}

function frontLegWidth(m: FrameModel, y: number): number | null {
  return legWidthAtRow(m, m.rowFor(y));
}

/** Widest chord perpendicular to the upper arm (bicep), metric. */
function bicepWidth(m: FrameModel, arm: FrameModel["armL"]): number | null {
  const [s, e] = arm;
  if (!s || !e) return null;
  const du = e.u - s.u;
  const dv = e.v - s.v;
  const len = Math.hypot(du, dv);
  if (!(len > 1)) return null;
  let best: number | null = null;
  for (let t = 0.35; t <= 0.8 + 1e-9; t += 0.025) {
    const pu = s.u + t * du;
    const pv = s.v + t * dv;
    const c = chordThrough(m.f.mask, pu, pv, -dv, du, 0.7 * len);
    if (!c) continue;
    const w = dist(metric(m.f, c.a[0], c.a[1]), metric(m.f, c.b[0], c.b[1]));
    if (best === null || w > best) best = w;
  }
  return best;
}

/** Narrowest chord perpendicular to the forearm just above the wrist landmark, metric. */
function wristWidth(m: FrameModel, arm: FrameModel["armL"]): number | null {
  const [, e, w] = arm;
  if (!e || !w) return null;
  const du = e.u - w.u;
  const dv = e.v - w.v;
  const len = Math.hypot(du, dv);
  if (!(len > 1)) return null;
  let best: number | null = null;
  for (let t = 0.02; t <= 0.12 + 1e-9; t += 0.01) {
    const pu = w.u + t * du;
    const pv = w.v + t * dv;
    const c = chordThrough(m.f.mask, pu, pv, -dv, du, 0.5 * len);
    if (!c) continue;
    const x = dist(metric(m.f, c.a[0], c.a[1]), metric(m.f, c.b[0], c.b[1]));
    if (best === null || x < best) best = x;
  }
  return best;
}

/** Outline edge at the shoulder landmark's row, on that shoulder's side (metric). */
function shoulderPoint(m: FrameModel, s: Pt | null): MPt | null {
  if (!s) return null;
  const span = spanAtRow(m.f.mask, s.v, m.torsoCenterU(s.v));
  if (!span) return null;
  const edge = Math.abs(span.u0 - s.u) < Math.abs(span.u1 - s.u) ? span.u0 : span.u1;
  return metric(m.f, edge, s.v);
}

const mean = (xs: (number | null)[]): number | null => {
  const v = xs.filter(fin);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// ------------------------------------------------------------------ one tuple

type TupleResult = { values: Partial<Record<MeasurementKey, number>>; levels: BodyLevels };

function measureTuple(F: FrameModel, S: FrameModel | null, B: FrameModel | null, H: number): TupleResult {
  const fp = ensureProfile(F, H);
  const sp = S ? ensureProfile(S, H) : null;
  const input: LevelInput = {
    heightCm: H,
    stepCm: PROFILE_STEP_CM,
    frontWidth: fp.torso,
    sideDepth: sp ? sp.torso : [],
    legWidth: fp.leg,
    legGap: fp.gap,
    armSeparated: fp.arms,
    landmarks: {
      shoulderY: F.y(LM.leftShoulder, LM.rightShoulder),
      mouthY: F.y(LM.mouthLeft, LM.mouthRight),
      hipY: F.y(LM.leftHip, LM.rightHip),
      kneeY: F.y(LM.leftKnee, LM.rightKnee),
      ankleY: F.y(LM.leftAnkle, LM.rightAnkle),
    },
  };
  const L = findLevels(input);
  const out: Partial<Record<MeasurementKey, number>> = {};
  const put = (k: MeasurementKey, x: number | null) => {
    if (fin(x) && x > 0) out[k] = x;
  };

  // Circumferences: front width x side depth at the same height.
  const torsoCirc = (y: number | null): number | null => {
    if (y === null || !S) return null;
    const w = F.torsoWidth(y);
    const d = S.torsoWidth(y);
    return w && d ? ellipseCircumference(w.width, d.width) : null;
  };
  put("neck", torsoCirc(L.neck));
  put("chest", torsoCirc(L.chest));
  put("bust", out.chest ?? null);
  put("underbust", torsoCirc(L.underbust));
  put("naturalWaist", torsoCirc(L.naturalWaist));
  put("pantWaist", torsoCirc(L.pantWaist));
  put("hips", torsoCirc(L.hips));
  const legCirc = (y: number | null): number | null => {
    if (y === null || !S) return null;
    const w = frontLegWidth(F, y);
    const d = sideLegDepth(S, y);
    return w !== null && d !== null ? ellipseCircumference(w, d) : null;
  };
  put("thigh", legCirc(L.thigh));
  put("knee", legCirc(L.knee));
  put("calf", legCirc(L.calf));

  const bw = mean([bicepWidth(F, F.armL), bicepWidth(F, F.armR)]);
  put("bicep", bw !== null ? ellipseCircumference(bw, bw * BICEP_DEPTH_RATIO) : null);
  const ww = mean([wristWidth(F, F.armL), wristWidth(F, F.armR)]);
  put("wrist", ww !== null ? ellipseCircumference(ww, ww * WRIST_DEPTH_RATIO) : null);

  // Lengths.
  if (L.shoulder !== null) {
    const fw = F.torsoWidth(L.shoulder)?.width ?? null;
    let bwid: number | null = null;
    if (B) {
      const bs = B.y(LM.leftShoulder, LM.rightShoulder);
      bwid = B.torsoWidth(bs ?? L.shoulder)?.width ?? null;
    }
    put("shoulderWidth", mean([fw, bwid]));
  }
  const sleeves: number[] = [];
  const shirt: number[] = [];
  const midSh = midPt(F.armL[0], F.armR[0]);
  const nape = L.nape !== null && midSh ? { x: metric(F.f, midSh.u, midSh.v).x, y: L.nape } : null;
  for (const arm of [F.armL, F.armR]) {
    const [s, e, w] = arm;
    const sp2 = shoulderPoint(F, s);
    if (!sp2 || !e || !w) continue;
    const em = metric(F.f, e.u, e.v);
    const wm = metric(F.f, w.u, w.v);
    const sl = dist(sp2, em) + dist(em, wm);
    sleeves.push(sl);
    if (nape) shirt.push(dist(nape, sp2) + sl);
  }
  put("sleeveLength", mean(sleeves));
  put("shirtSleeve", mean(shirt));
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
  put("backLength", diff(L.nape, L.naturalWaist));
  put("inseam", diff(L.crotch, L.ankle));
  put("outseam", diff(L.pantWaist, L.ankle));
  put("rise", diff(L.pantWaist, L.crotch));
  put("shoulderToWaist", diff(L.shoulder, L.naturalWaist));
  if (L.nape !== null && L.crotch !== null && L.naturalWaist !== null && S) {
    const d = S.torsoWidth(L.naturalWaist);
    if (d) put("torsoLength", ellipseCircumference(L.nape - L.crotch, d.width));
  }
  if (S) {
    const feet: number[] = [];
    for (const [hi, ti] of [[LM.leftHeel, LM.leftFootIndex], [LM.rightHeel, LM.rightFootIndex]] as const) {
      const h = lmPx(S.f, hi);
      const t = lmPx(S.f, ti);
      if (h && t) feet.push(dist(metric(S.f, h.u, h.v), metric(S.f, t.u, t.v)));
    }
    put("footLength", mean(feet));
  }
  return { values: out, levels: L };
}

// ------------------------------------------------------------------ aggregation

/** Mean and spread after dropping outliers (> 3 robust SD from the median, n >= 4). */
export function robustStats(xs: number[]): { mean: number; sd: number; n: number } | null {
  const v = xs.filter(fin);
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const med = median(sorted);
  let kept = v;
  if (v.length >= 4) {
    const mad = median(v.map((x) => Math.abs(x - med)).sort((a, b) => a - b));
    const lim = 3 * 1.4826 * mad + 1e-6;
    kept = v.filter((x) => Math.abs(x - med) <= lim);
  }
  const m = kept.reduce((a, b) => a + b, 0) / kept.length;
  const sd = kept.length > 1 ? Math.sqrt(kept.reduce((a, b) => a + (b - m) ** 2, 0) / (kept.length - 1)) : 0;
  return { mean: m, sd, n: kept.length };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Levels each measurement depends on (a fallback level lowers its confidence). */
const LEVEL_DEPS: Partial<Record<MeasurementKey, LevelName[]>> = {
  neck: ["neck"], chest: ["chest"], bust: ["chest"], underbust: ["underbust", "chest"],
  naturalWaist: ["naturalWaist"], pantWaist: ["naturalWaist"], hips: ["hips", "crotch"],
  thigh: ["crotch"], calf: ["calf"], inseam: ["crotch"], rise: ["crotch", "naturalWaist"],
  outseam: ["naturalWaist"], backLength: ["nape", "naturalWaist"], shirtSleeve: ["nape"],
  shoulderToWaist: ["naturalWaist"], torsoLength: ["nape", "crotch", "naturalWaist"],
};

/** Confidence from uncertainty vs target: u = target/2 -> 0.75, u = target -> 0.5. */
export function confidenceFor(uncertaintyCm: number, targetCm: number | null): number {
  if (targetCm === null || !(targetCm > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - (0.5 * uncertaintyCm) / targetCm));
}

function medianLevels(all: BodyLevels[]): BodyLevels {
  const names: LevelName[] = [
    "shoulder", "nape", "neck", "armpit", "chest", "underbust", "naturalWaist", "pantWaist",
    "hipJoint", "hips", "crotch", "thigh", "knee", "calf", "ankle",
  ];
  const out = { fallbacks: [] as LevelName[] } as BodyLevels;
  for (const k of names) {
    const v = all.map((l) => l[k]).filter(fin).sort((a, b) => a - b);
    out[k] = v.length ? median(v) : null;
    if (all.filter((l) => l.fallbacks.includes(k)).length * 2 > all.length) out.fallbacks.push(k);
  }
  return out;
}

export function computeMeasurements(
  views: ViewData[],
  inputs: ScanInputs,
  factors: CorrectionFactors | null,
  options: ComputeOptions = {},
): { measurements: Measurements; rawMeasurements: RawMeasurements; levels: BodyLevels | null } {
  const H = inputs.heightCm;
  const measurements: Measurements = {};
  const rawMeasurements: RawMeasurements = {};
  const kFor = (key: MeasurementKey): number => {
    const k = factors?.[inputs.bodyType]?.[key];
    return fin(k) && k > 0 ? k : 1;
  };
  if (fin(H) && H > 0) {
    measurements.height = { valueCm: H, uncertaintyCm: 0, confidence: 1 };
    rawMeasurements.height = H;
  } else {
    return { measurements, rawMeasurements, levels: null };
  }

  const usable = (vn: ViewName) =>
    (views.find((v) => v.view === vn)?.frames ?? []).filter((f) => f && f.mask && f.plane && f.landmarksPx);
  const models = (vn: ViewName) => usable(vn).map((f) => frameModel(f, vn));
  let front = models("front");
  const side = models("side");
  const back = models("back");
  if (front.length === 0) front = back; // back A-pose gives the same widths
  if (front.length === 0) return { measurements, rawMeasurements, levels: null };

  const nT = Math.max(front.length, side.length, back.length);
  const tuples: TupleResult[] = [];
  for (let i = 0; i < nT; i++) {
    const F = front[i % front.length];
    const S = side.length ? side[i % side.length] : null;
    const B = back.length && back !== front ? back[i % back.length] : null;
    tuples.push(measureTuple(F, S, B, H));
  }
  const levels = medianLevels(tuples.map((t) => t.levels));

  for (const spec of MEASUREMENT_SPECS) {
    const key = spec.key;
    if (key === "height") continue;
    const st = robustStats(tuples.map((t) => t.values[key]).filter(fin));
    if (!st) continue;
    let u = st.sd + (options.hasDistortionK1 ? 0 : DISTORTION_UNCERTAINTY_FRAC * st.mean);
    let conf = confidenceFor(u, spec.targetCm);
    if (st.n < 3) conf = Math.min(conf, 0.7);
    if ((LEVEL_DEPS[key] ?? []).some((l) => levels.fallbacks.includes(l))) conf = Math.min(conf, 0.6);
    if (spec.alwaysLowConfidence) conf = Math.min(conf, 0.7);
    const k = kFor(key);
    rawMeasurements[key] = st.mean;
    u *= k;
    measurements[key] = { valueCm: st.mean * k, uncertaintyCm: u, confidence: conf };
  }
  return { measurements, rawMeasurements, levels };
}
