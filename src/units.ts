// Pure cm <-> inch helpers (design doc section 6: inches by default,
// cm toggle; inches shown to the nearest 0.25").
import type { Units } from "./types";

export const CM_PER_IN = 2.54;

/** Plausible adult/teen height range accepted by Setup, in cm. */
export const MIN_HEIGHT_CM = 100;
export const MAX_HEIGHT_CM = 250;

export function cmToIn(cm: number): number {
  return cm / CM_PER_IN;
}

export function inToCm(inches: number): number {
  return inches * CM_PER_IN;
}

/** Round to the nearest 0.25. */
export function roundQuarter(x: number): number {
  return Math.round(x * 4) / 4;
}

function inchString(inches: number): string {
  const q = roundQuarter(inches);
  // 38.5 -> "38.5", 32 -> "32.0", 38.25 -> "38.25"
  const decimals = Math.abs((q * 2) % 1) < 1e-9 ? 1 : 2;
  return q.toFixed(decimals);
}

/** 98.4 -> `38.75"` (in) or `98.4 cm` (cm). Non-finite -> "-". */
export function formatLength(cm: number, units: Units): string {
  if (!Number.isFinite(cm)) return "-";
  if (units === "in") return `${inchString(cmToIn(cm))}"`;
  return `${cm.toFixed(1)} cm`;
}

/** Uncertainty / error with one decimal: `±1.0"` or `±2.5 cm`. */
export function formatPlusMinus(cm: number, units: Units): string {
  if (!Number.isFinite(cm)) return "";
  const v = units === "in" ? `${cmToIn(Math.abs(cm)).toFixed(1)}"` : `${Math.abs(cm).toFixed(1)} cm`;
  return `±${v}`;
}

/** Small values (errors) with one decimal and no rounding to 0.25". */
export function formatSmallLength(cm: number, units: Units): string {
  if (!Number.isFinite(cm)) return "-";
  return units === "in" ? `${cmToIn(cm).toFixed(1)}"` : `${cm.toFixed(1)} cm`;
}

function toNumber(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the Setup height fields into cm.
 * - units "in": a = feet, b = inches (inches may be empty = 0)
 * - units "cm": a = centimetres (b ignored)
 * Returns null when empty, negative or outside MIN..MAX_HEIGHT_CM.
 */
export function parseHeight(
  units: Units,
  a: string | number | null | undefined,
  b?: string | number | null,
): number | null {
  let cm: number;
  if (units === "cm") {
    const n = toNumber(a);
    if (n === null) return null;
    cm = n;
  } else {
    const ft = toNumber(a);
    const inchRaw = toNumber(b);
    if (ft === null && inchRaw === null) return null;
    const f = ft ?? 0;
    const i = inchRaw ?? 0;
    if (f < 0 || i < 0 || i >= 12 || !Number.isInteger(f)) return null;
    cm = inToCm(f * 12 + i);
  }
  if (cm < MIN_HEIGHT_CM || cm > MAX_HEIGHT_CM) return null;
  return Math.round(cm * 10) / 10;
}

/** cm -> { feet, inches } with inches rounded to 0.25 (for pre-filling Setup). */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const total = roundQuarter(cmToIn(cm));
  let feet = Math.floor(total / 12);
  let inches = roundQuarter(total - feet * 12);
  if (inches >= 12) {
    feet += 1;
    inches -= 12;
  }
  return { feet, inches };
}

/** Parse a single length field (tape value) typed in `units`; returns cm or null. */
export function parseLength(value: string, units: Units): number | null {
  const n = toNumber(value);
  if (n === null || n <= 0) return null;
  return units === "in" ? inToCm(n) : n;
}

/** cm -> number in `units` for an input field (in: 0.25 steps, cm: 0.1). */
export function lengthInputValue(cm: number, units: Units): string {
  if (!Number.isFinite(cm)) return "";
  return units === "in" ? String(roundQuarter(cmToIn(cm))) : String(Math.round(cm * 10) / 10);
}
