// PURE validation statistics and correction factors (design doc sections 6, 7).

import type { BodyType, CorrectionFactors, MeasurementKey, ScanDoc } from "../types";
import { MEASUREMENT_SPECS } from "../types";

export interface ValidationRow {
  key: MeasurementKey;
  /** Number of scans with both a scan value and a tape value for this key. */
  n: number;
  /** Mean absolute error |scan - tape| in cm. */
  maeCm: number;
  /** Percentage (0..100) of those scans whose error is <= the key's accuracy target. */
  pctWithinTarget: number;
}

/**
 * Tape/raw ratios outside this range are treated as data-entry mistakes
 * (e.g. inches typed as cm) and ignored when computing k.
 */
export const K_RATIO_MIN = 0.5;
export const K_RATIO_MAX = 2;

/** Small tolerance so an error exactly at the target counts despite float rounding. */
const EPS = 1e-9;

function isPositive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function hasTape(scan: ScanDoc): scan is ScanDoc & { tapeMeasurements: NonNullable<ScanDoc["tapeMeasurements"]> } {
  return !!scan.tapeMeasurements && Object.values(scan.tapeMeasurements).some(isPositive);
}

/** Scans that carry at least one usable tape value ("12 scans with tape values"). */
export function tapeScanCount(scans: ScanDoc[]): number {
  return scans.filter(hasTape).length;
}

/**
 * Per measurement key: MAE of measurements[key].valueCm vs tape, and % within
 * target. Only scans with tapeMeasurements count; keys without an accuracy
 * target (height, which is an input) are skipped. Rows follow
 * MEASUREMENT_SPECS order; keys with no data are omitted.
 */
export function validationStats(scans: ScanDoc[]): ValidationRow[] {
  const rows: ValidationRow[] = [];
  const withTape = scans.filter(hasTape);
  for (const spec of MEASUREMENT_SPECS) {
    if (spec.targetCm === null) continue;
    let n = 0;
    let sumAbs = 0;
    let within = 0;
    for (const scan of withTape) {
      const tape = scan.tapeMeasurements[spec.key];
      const value = scan.measurements[spec.key]?.valueCm;
      if (!isPositive(tape) || !isPositive(value)) continue;
      const err = Math.abs(value - tape);
      n++;
      sumAbs += err;
      if (err <= spec.targetCm + EPS) within++;
    }
    if (n > 0) rows.push({ key: spec.key, n, maeCm: sumAbs / n, pctWithinTarget: (within / n) * 100 });
  }
  return rows;
}

/**
 * k = mean(tape / raw) per circumference key and bodyType, from
 * rawMeasurements (uncorrected). Only keys with >= minScans usable samples
 * get a factor; others are absent (=> k = 1.0 downstream). updatedAt is left
 * unset (the saver stamps it).
 */
export function computeCorrectionFactors(scans: ScanDoc[], minScans = 3): CorrectionFactors {
  const ratios: Record<BodyType, Partial<Record<MeasurementKey, number[]>>> = {
    male: {},
    female: {},
    unspecified: {},
  };
  const circumferences = MEASUREMENT_SPECS.filter((s) => s.kind === "circumference").map((s) => s.key);
  for (const scan of scans) {
    if (!hasTape(scan)) continue;
    const bucket = ratios[scan.bodyType] ?? ratios.unspecified;
    for (const key of circumferences) {
      const tape = scan.tapeMeasurements[key];
      const raw = scan.rawMeasurements?.[key];
      if (!isPositive(tape) || !isPositive(raw)) continue;
      const r = tape / raw;
      if (r < K_RATIO_MIN || r > K_RATIO_MAX) continue;
      (bucket[key] ??= []).push(r);
    }
  }
  const out: CorrectionFactors = { male: {}, female: {}, unspecified: {} };
  const need = Math.max(1, minScans);
  for (const bodyType of ["male", "female", "unspecified"] as const) {
    for (const [key, list] of Object.entries(ratios[bodyType]) as [MeasurementKey, number[]][]) {
      if (list.length >= need) out[bodyType][key] = list.reduce((a, b) => a + b, 0) / list.length;
    }
  }
  return out;
}
