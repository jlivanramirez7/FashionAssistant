// PURE display helpers for the screens (unit-tested in tests/ui-flow).
import {
  MEASUREMENT_SPECS,
  VIEWS,
  type BodyType,
  type MeasurementGroup,
  type MeasurementKey,
  type MeasurementSpec,
  type Measurements,
  type PoseHint,
  type ScanDoc,
  type Units,
  type ViewName,
} from "../types";
import { formatLength, formatPlusMinus, parseLength } from "../units";

// ---------------------------------------------------------------- confidence

export type ConfidenceColor = "green" | "amber" | "red";

/** >= 0.75 green, >= 0.5 amber, else red (contract). */
export function confidenceColor(confidence: number): ConfidenceColor {
  if (!(confidence >= 0.5)) return "red"; // also NaN
  return confidence >= 0.75 ? "green" : "amber";
}

// ---------------------------------------------------------------- labels

/** "Bust" (female), "Chest" (male), "Chest / bust" (unspecified). */
export function chestLabel(bodyType: BodyType): string {
  if (bodyType === "female") return "Bust";
  if (bodyType === "male") return "Chest";
  return "Chest / bust";
}

export function specFor(key: MeasurementKey): MeasurementSpec {
  const s = MEASUREMENT_SPECS.find((m) => m.key === key);
  if (!s) throw new Error(`Unknown measurement key ${key}`);
  return s;
}

export function measurementLabel(key: MeasurementKey, bodyType: BodyType): string {
  return key === "chest" ? chestLabel(bodyType) : specFor(key).label;
}

// ---------------------------------------------------------------- visible keys

/**
 * Chest and bust are the same measurement (section 7). The UI shows ONE row
 * (key "chest", in Tops, labelled by bodyType) and hides "bust" everywhere;
 * "bust" stays stored on the server.
 */
export const HIDDEN_KEYS: readonly MeasurementKey[] = ["bust"];

export function isVisibleKey(key: MeasurementKey): boolean {
  return !HIDDEN_KEYS.includes(key);
}

/** Copy of `m` for display: chest falls back to bust, bust removed. */
export function visibleMeasurements<T>(m: Partial<Record<MeasurementKey, T>> | undefined): Partial<Record<MeasurementKey, T>> {
  const out: Partial<Record<MeasurementKey, T>> = { ...(m ?? {}) };
  if (out.chest === undefined && out.bust !== undefined) out.chest = out.bust;
  delete out.bust;
  return out;
}

export const GROUP_ORDER: readonly MeasurementGroup[] = ["tops", "bottoms", "dresses", "shoes", "general"];

export const GROUP_TITLES: Record<MeasurementGroup, string> = {
  tops: "Tops",
  bottoms: "Bottoms",
  dresses: "Dresses & one-pieces",
  shoes: "Shoes",
  general: "General",
};

/** Measurements present in `m`, grouped in Results order (empty groups dropped). */
export function groupMeasurements(m: Measurements): { group: MeasurementGroup; title: string; keys: MeasurementKey[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    title: GROUP_TITLES[group],
    keys: MEASUREMENT_SPECS.filter((s) => s.group === group && isVisibleKey(s.key) && m[s.key] !== undefined).map((s) => s.key),
  })).filter((g) => g.keys.length > 0);
}

// ---------------------------------------------------------------- retakes

/** Which capture steps each measurement depends on (section 7 table). */
export const KEY_VIEWS: Record<MeasurementKey, ViewName[]> = {
  height: ["front"],
  neck: ["front", "side"],
  chest: ["front", "side"],
  naturalWaist: ["front", "side"],
  shoulderWidth: ["front", "back"],
  sleeveLength: ["front"],
  shirtSleeve: ["front"],
  backLength: ["side", "back"],
  bicep: ["front", "side"],
  wrist: ["front", "side"],
  pantWaist: ["front", "side"],
  hips: ["front", "side"],
  inseam: ["front"],
  outseam: ["front", "side"],
  rise: ["front", "side"],
  thigh: ["front", "side"],
  knee: ["front", "side"],
  calf: ["front", "side"],
  bust: ["front", "side"],
  underbust: ["front", "side"],
  shoulderToWaist: ["front", "side"],
  torsoLength: ["front", "side"],
  footLength: ["side"],
};

/** Keys shown amber/red that a retake could improve (alwaysLowConfidence keys and height excluded). */
export function lowConfidenceKeys(measurements: Measurements): MeasurementKey[] {
  const m = visibleMeasurements(measurements);
  return MEASUREMENT_SPECS.filter((s) => {
    const v = m[s.key];
    if (!v || s.alwaysLowConfidence || s.targetCm === null) return false;
    return confidenceColor(v.confidence) !== "green";
  }).map((s) => s.key);
}

/** Steps to recapture for "Retake amber/red", in front > side > back order. */
export function retakeViewsFor(m: Measurements): ViewName[] {
  const needed = new Set<ViewName>();
  for (const k of lowConfidenceKeys(m)) for (const v of KEY_VIEWS[k]) needed.add(v);
  return VIEWS.filter((v) => needed.has(v));
}

// ---------------------------------------------------------------- capture text

export interface StepText {
  /** Huge on-screen text (<= ~6 words). */
  title: string;
  /** Spoken full sentence. */
  sentence: string;
}

/** Section 6 S5 - never "turn left/right". */
export const STEP_TEXT: Record<ViewName, StepText> = {
  front: {
    title: "FRONT, ARMS OUT",
    sentence: "Face the phone. Arms out about 45 degrees, palms forward, feet hip-width apart.",
  },
  side: {
    title: "RIGHT SHOULDER TO PHONE",
    sentence: "Turn so your right shoulder faces the phone. Arms relaxed at your sides.",
  },
  back: {
    title: "BACK TO PHONE, ARMS OUT",
    sentence: "Turn so your back faces the phone. Arms out about 45 degrees.",
  },
};

const HINT_TEXT: Record<Exclude<PoseHint, "ok">, StepText> = {
  "no-person": { title: "STEP INTO VIEW", sentence: "Stand in front of the phone so I can see all of you." },
  "step-back": { title: "STEP BACK", sentence: "Step back until I can see your head and your feet." },
  "move-closer": { title: "MOVE TOWARD THE PHONE", sentence: "Move a little toward the phone." },
  center: { title: "MOVE TO THE MIDDLE", sentence: "Move to the middle of the picture." },
  "arms-out": { title: "ARMS OUT A BIT", sentence: "Hold your arms out about 45 degrees from your body." },
  "arms-down": { title: "ARMS DOWN", sentence: "Relax your arms down at your sides." },
  "face-phone": { title: "FACE THE PHONE", sentence: "Turn so you face the phone." },
  "turn-side": { title: "RIGHT SHOULDER TO PHONE", sentence: "Turn so your right shoulder faces the phone." },
  "turn-back": { title: "BACK TO PHONE", sentence: "Turn so your back faces the phone." },
  "hold-still": { title: "HOLD STILL", sentence: "Hold still." },
};

/** On-screen text + spoken sentence for a live pose hint. */
export function hintText(hint: PoseHint): StepText {
  if (hint === "ok") return { title: "HOLD STILL", sentence: "Hold still." };
  return HINT_TEXT[hint];
}

export type BorderStatus = "red" | "amber" | "green";

/** Border colour from the hint: red = not ready, amber = hold still, green = capturing. */
export function borderFor(hint: PoseHint | null, capturing: boolean): BorderStatus {
  if (capturing) return "green";
  return hint === "ok" || hint === "hold-still" ? "amber" : "red";
}

// ---------------------------------------------------------------- dates & copy

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** epoch ms -> "Oct 10, 2026" (local time). */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}, ${d.getFullYear()}`;
}

/** Plain-text list for "Copy all" (section 6 S7). */
export function copyAllText(scan: Pick<ScanDoc, "measurements" | "bodyType" | "createdAt">, units: Units): string {
  const lines = [`My measurements (${formatDate(scan.createdAt)})`];
  const m = visibleMeasurements(scan.measurements);
  for (const g of groupMeasurements(m)) {
    lines.push("", g.title);
    for (const k of g.keys) {
      const v = m[k]!;
      lines.push(`${measurementLabel(k, scan.bodyType)}: ${formatLength(v.valueCm, units)} (${formatPlusMinus(v.uncertaintyCm, units)})`);
    }
  }
  return lines.join("\n");
}

/** Short summary for Home: Chest / Waist / Inseam when present. */
export function homeSummary(scan: Pick<ScanDoc, "measurements" | "bodyType">, units: Units): string[] {
  const keys: MeasurementKey[] = ["chest", "naturalWaist", "inseam"];
  const m = visibleMeasurements(scan.measurements);
  return keys
    .filter((k) => m[k])
    .map((k) => `${measurementLabel(k, scan.bodyType)} ${formatLength(m[k]!.valueCm, units)}`);
}

/** Tape value shown in a S9 field (chest falls back to a stored bust value). */
export function tapeForField(tape: Partial<Record<MeasurementKey, number>> | undefined, key: MeasurementKey): number | undefined {
  return visibleMeasurements(tape)[key];
}

// ---------------------------------------------------------------- placement text

/** Hint for the level gauge (tilt 60-85 deg from flat, |roll| <= 3). */
export function placementHint(o: { tiltDeg: number; rollDeg: number } | null): { tiltOk: boolean; rollOk: boolean; text: string } {
  if (!o) return { tiltOk: false, rollOk: false, text: "Waiting for the motion sensor..." };
  const tiltOk = o.tiltDeg >= 60 && o.tiltDeg <= 85;
  const rollOk = Math.abs(o.rollDeg) <= 3;
  let text = "Perfect - hold it there";
  if (!tiltOk) text = o.tiltDeg > 85 ? "Tilt it back a bit" : "Stand it up a bit more";
  else if (!rollOk) text = "Level it side to side";
  return { tiltOk, rollOk, text };
}

// ---------------------------------------------------------------- validation (S9)

/** Keys with a tape field on S9 (every measurement except the height input). */
export const TAPE_KEYS: readonly MeasurementKey[] = MEASUREMENT_SPECS.filter(
  (s) => s.key !== "height" && isVisibleKey(s.key),
).map((s) => s.key);

/** Typed tape fields (in `units`) -> tapeMeasurements in cm; blank/invalid fields dropped. */
export function buildTapeMeasurements(
  fields: Partial<Record<MeasurementKey, string>>,
  units: Units,
): Partial<Record<MeasurementKey, number>> {
  const out: Partial<Record<MeasurementKey, number>> = {};
  for (const [k, v] of Object.entries(fields) as [MeasurementKey, string | undefined][]) {
    if (v === undefined) continue;
    const cm = parseLength(v, units);
    if (cm !== null) out[k] = Math.round(cm * 100) / 100;
  }
  // The single chest / bust row is saved under both keys.
  if (out.chest !== undefined) out.bust = out.chest;
  else delete out.bust;
  return out;
}
