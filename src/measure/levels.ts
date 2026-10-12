// Body level finder (design doc section 7, "Body level definitions").
// All heights are cm above the floor in the perspective-corrected, height-scaled plane.
// Input profiles are sampled on a regular grid y_i = i * stepCm (i = 0..n-1).

export interface LevelLandmarks {
  /** Mean shoulder-landmark height (front view). */
  shoulderY: number | null;
  /** Mean mouth-corner height. */
  mouthY: number | null;
  /** Mean hip-landmark height. */
  hipY: number | null;
  kneeY: number | null;
  ankleY: number | null;
}

export interface LevelInput {
  heightCm: number;
  stepCm: number;
  /** Front (or back) width of the run containing the body centre line (neck/torso), cm. */
  frontWidth: (number | null)[];
  /** Side-view depth of the run containing the body centre line, cm. */
  sideDepth: (number | null)[];
  /** Front view: mean single-leg width, cm. */
  legWidth: (number | null)[];
  /** Front view: background between the two legs at the centre column. */
  legGap: (boolean | null)[];
  /** Front A-pose: both arm outlines separated from the torso run. */
  armSeparated: (boolean | null)[];
  landmarks: LevelLandmarks;
}

export type LevelName =
  | "shoulder" | "nape" | "neck" | "armpit" | "chest" | "underbust" | "naturalWaist"
  | "pantWaist" | "hipJoint" | "hips" | "crotch" | "thigh" | "knee" | "calf" | "ankle";

export type BodyLevels = Record<LevelName, number | null> & {
  /** Levels that came from a fallback rule instead of the outline (lower confidence). */
  fallbacks: LevelName[];
};

/** Pant waist (belt line) = hip landmark + this fraction of the way up to the natural waist. */
export const PANT_WAIST_FRACTION = 0.4;
/** The crotch is searched from the hip joint down to this fraction of the height below it. */
export const CROTCH_SEARCH_FRAC = 0.14;
/** Fallback crotch: this fraction of the height below the hip-joint landmarks. */
export const CROTCH_BELOW_HIP_FRAC = 0.06;
/** A leg gap must be open for at least this long (cm) to count as the crotch. */
const CROTCH_MIN_GAP_CM = 1;
/** Thigh level below the crotch, cm. */
export const THIGH_BELOW_CROTCH_CM = 5;
/** Half-window (cm) of the parabola fit that refines extrema. */
const WIN = 2;

function smooth(arr: (number | null)[], half = 2): (number | null)[] {
  const out: (number | null)[] = new Array(arr.length).fill(null);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null || !Number.isFinite(arr[i] as number)) continue;
    let s = 0;
    let n = 0;
    for (let k = i - half; k <= i + half; k++) {
      const x = arr[k];
      if (k >= 0 && k < arr.length && x !== null && x !== undefined && Number.isFinite(x)) {
        s += x;
        n++;
      }
    }
    out[i] = n ? s / n : null;
  }
  return out;
}

export function findLevels(input: LevelInput): BodyLevels {
  const H = input.heightCm;
  const step = input.stepCm > 0 ? input.stepCm : 0.25;
  const L = input.landmarks;
  const fallbacks: LevelName[] = [];
  const fw = smooth(input.frontWidth);
  const sd = smooth(input.sideDepth);
  const lw = smooth(input.legWidth);
  const rawOf = new Map<(number | null)[], (number | null)[]>([[fw, input.frontWidth], [sd, input.sideDepth], [lw, input.legWidth]]);
  const idx = (y: number) => Math.round(y / step);
  const yOf = (i: number) => i * step;
  const fin = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

  /** y of the min/max of arr over [y0, y1]; centre of the plateau within tol of the extremum. */
  const ext = (arr: (number | null)[], y0: number, y1: number, kind: "min" | "max", tol = 0.05): number | null => {
    if (!fin(y0) || !fin(y1)) return null;
    const a = Math.max(0, Math.ceil(Math.min(y0, y1) / step));
    const b = Math.min(arr.length - 1, Math.floor(Math.max(y0, y1) / step));
    let best = -1;
    for (let i = a; i <= b; i++) {
      const x = arr[i];
      if (!fin(x)) continue;
      const bx = best >= 0 ? (arr[best] as number) : NaN;
      if (best < 0 || (kind === "min" ? x < bx : x > bx)) best = i;
    }
    if (best < 0) return null;
    const bv = arr[best] as number;
    const near = (i: number) => i >= a && i <= b && fin(arr[i]) && Math.abs((arr[i] as number) - bv) <= tol;
    let lo = best;
    let hi = best;
    while (near(lo - 1)) lo--;
    while (near(hi + 1)) hi++;
    const c0 = (lo + hi) / 2;
    // Refine with a least-squares parabola over +/-2 cm (outline widths are pixel-quantized).
    const w = Math.max(2, Math.round(WIN / step));
    const src = rawOf.get(arr) ?? arr;
    const i0 = Math.max(a, Math.round(c0) - w);
    const i1 = Math.min(b, Math.round(c0) + w);
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
    for (let i = i0; i <= i1; i++) {
      const x = src[i];
      if (!fin(x)) continue;
      const d = i - c0;
      s0 += 1; s1 += d; s2 += d * d; s3 += d * d * d; s4 += d * d * d * d;
      t0 += x; t1 += x * d; t2 += x * d * d;
    }
    if (s0 >= 5) {
      // Solve [s4 s3 s2; s3 s2 s1; s2 s1 s0] [A B C] = [t2 t1 t0]
      const det = s4 * (s2 * s0 - s1 * s1) - s3 * (s3 * s0 - s1 * s2) + s2 * (s3 * s1 - s2 * s2);
      if (Math.abs(det) > 1e-12) {
        const A = (t2 * (s2 * s0 - s1 * s1) - s3 * (t1 * s0 - s1 * t0) + s2 * (t1 * s1 - s2 * t0)) / det;
        const B = (s4 * (t1 * s0 - s1 * t0) - t2 * (s3 * s0 - s1 * s2) + s2 * (s3 * t0 - t1 * s2)) / det;
        const ok = kind === "min" ? A > 1e-9 : A < -1e-9;
        if (ok) {
          const vx = c0 - B / (2 * A);
          if (vx >= i0 && vx <= i1) return yOf(vx);
        }
      }
    }
    return yOf(c0);
  };
  const valAt = (arr: (number | null)[], y: number): number | null => {
    const v = arr[idx(y)];
    return fin(v) ? v : null;
  };

  const shoulder = fin(L.shoulderY) ? L.shoulderY : null;
  const hipJoint = fin(L.hipY) ? L.hipY : null;
  const knee = fin(L.kneeY) ? L.kneeY : null;
  const ankle = fin(L.ankleY) ? L.ankleY : null;

  // Neck: narrowest front width between the shoulder line and the mouth.
  let neck: number | null = null;
  if (shoulder !== null) {
    let mouth = fin(L.mouthY) ? L.mouthY : null;
    if (mouth === null) mouth = shoulder + 0.085 * H;
    neck = ext(fw, shoulder, mouth, "min");
    if (neck === null) {
      neck = shoulder + 0.04 * H;
      fallbacks.push("neck");
    } else if (!fin(L.mouthY)) fallbacks.push("neck");
  }

  // Nape: lowest height above the shoulder line where the outline has narrowed to the neck.
  let nape: number | null = null;
  if (shoulder !== null && neck !== null) {
    const raw = input.frontWidth;
    const nw = valAt(fw, neck);
    if (nw !== null) {
      for (let i = idx(shoulder); i <= idx(neck); i++) {
        const x = raw[i];
        if (fin(x) && x <= 1.25 * nw) {
          nape = yOf(i);
          break;
        }
      }
    }
    if (nape === null) {
      nape = Math.min(neck, shoulder + 0.02 * H);
      fallbacks.push("nape");
    }
  }

  // Armpit: first height below the shoulder where the arms separate from the torso (for >= 1 cm).
  let armpit: number | null = null;
  if (shoulder !== null) {
    const lowest = hipJoint ?? shoulder - 0.3 * H;
    const need = Math.max(1, Math.round(1 / step));
    for (let i = idx(shoulder); i >= idx(lowest); i--) {
      let ok = true;
      for (let k = 0; k <= need; k++) if (input.armSeparated[i - k] !== true) ok = false;
      if (ok) {
        armpit = yOf(i);
        break;
      }
    }
    if (armpit === null) {
      armpit = shoulder - 0.06 * H;
      fallbacks.push("armpit");
    }
  }

  // Natural waist: narrowest front torso width in the waist band between hips and chest.
  let naturalWaist: number | null = null;
  if (shoulder !== null && hipJoint !== null && armpit !== null) {
    const span = shoulder - hipJoint;
    const lo = hipJoint + 0.2 * span;
    const hi = Math.min(hipJoint + 0.65 * span, armpit - 2);
    naturalWaist = ext(fw, lo, hi, "min");
    if (naturalWaist === null) {
      naturalWaist = hipJoint + 0.35 * span;
      fallbacks.push("naturalWaist");
    }
  }

  // Chest/bust: greatest side depth between the armpit and the natural waist.
  let chest: number | null = null;
  let underbust: number | null = null;
  if (armpit !== null && naturalWaist !== null) {
    chest = ext(sd, naturalWaist, armpit, "max");
    if (chest === null) {
      chest = armpit - 0.35 * (armpit - naturalWaist);
      fallbacks.push("chest");
    }
    // Underbust: narrowest side depth in the upper half of the bust-to-waist span.
    underbust = ext(sd, chest - (chest - naturalWaist) / 2, chest - 1, "min");
    if (underbust === null) {
      underbust = chest - 0.3 * (chest - naturalWaist);
      fallbacks.push("underbust");
    }
  }

  const pantWaist =
    hipJoint !== null && naturalWaist !== null ? hipJoint + PANT_WAIST_FRACTION * (naturalWaist - hipJoint) : null;

  // Crotch: top of the gap between the legs (front mask), scanning DOWN from the
  // hip joint. (Scanning up from the ankles stops wherever the knees or thighs
  // touch - real scans put the crotch at knee height.) The gap must stay open
  // for CROTCH_MIN_GAP_CM; when the thighs touch over the whole search band the
  // crotch falls back to a body proportion below the hip joint.
  let crotch: number | null = null;
  if (hipJoint !== null) {
    const top = idx(hipJoint) - 1;
    const bottom = Math.max(0, idx(hipJoint - CROTCH_SEARCH_FRAC * H));
    const need = Math.max(1, Math.round(CROTCH_MIN_GAP_CM / step));
    for (let i = top; i >= bottom; i--) {
      let open = true;
      for (let k = 0; k < need; k++) if (input.legGap[i - k] !== true) open = false;
      if (open) {
        crotch = yOf(i) + step / 2;
        break;
      }
    }
    if (crotch === null) {
      crotch = hipJoint - CROTCH_BELOW_HIP_FRAC * H;
      fallbacks.push("crotch");
    }
  }

  // Hips/seat: greatest side depth between the crotch and the hip landmarks.
  let hips: number | null = null;
  if (crotch !== null && hipJoint !== null) {
    hips = ext(sd, crotch, hipJoint, "max");
    if (hips === null) {
      hips = hipJoint - 0.02 * H;
      fallbacks.push("hips");
    }
  }

  const thigh = crotch !== null ? crotch - THIGH_BELOW_CROTCH_CM : null;

  // Calf: widest lower-leg width between knee and ankle.
  let calf: number | null = null;
  if (knee !== null && ankle !== null && knee > ankle) {
    const s = knee - ankle;
    calf = ext(lw, ankle + 0.4 * s, knee - 0.15 * s, "max");
    if (calf === null) {
      calf = knee - 0.3 * s;
      fallbacks.push("calf");
    }
  }

  return {
    shoulder, nape, neck, armpit, chest, underbust, naturalWaist, pantWaist,
    hipJoint, hips, crotch, thigh, knee, calf, ankle, fallbacks,
  };
}
