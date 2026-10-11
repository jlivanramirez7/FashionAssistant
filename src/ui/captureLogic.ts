// PURE timing helpers for the Capture screen (unit-tested in tests/ui-flow).
import type { PoseHint, ViewName } from "../types";

/** A pose that drops out for less than this still counts as held (one-frame model glitches). */
export const GLITCH_MS = 400;
/** Stuck this long on "which way are you facing" -> trust the user and skip that test. */
export const TRUST_ORIENTATION_MS = 5000;
/** Seconds counted down by the "Timer" capture. */
export const TIMER_SECONDS = 10;
/** Longest frame gap credited to the orientation timer (tab hidden etc.). */
const MAX_DT_MS = 250;

/** The orientation hint a step can get stuck on (null: never waived). */
export function orientationHintFor(view: ViewName): PoseHint | null {
  if (view === "back") return "turn-back";
  if (view === "side") return "turn-side";
  return null;
}

export interface HoldGate {
  /** Start of the current "ok" stretch (glitches under GLITCH_MS bridged). */
  okSince: number | null;
  lastOk: number;
}

export function createHoldGate(): HoldGate {
  return { okSince: null, lastOk: -Infinity };
}

/** Feed one frame; returns how long the pose has been held (ms), or null. */
export function updateHold(g: HoldGate, ok: boolean, now: number): number | null {
  if (ok) {
    g.lastOk = now;
    g.okSince ??= now;
  } else if (now - g.lastOk > GLITCH_MS) {
    g.okSince = null;
  }
  return g.okSince === null ? null : now - g.okSince;
}

export function resetHold(g: HoldGate): void {
  g.okSince = null;
  g.lastOk = -Infinity;
}

export interface TrustGate {
  stuckMs: number;
  lastT: number | null;
  trusted: boolean;
}

export function createTrustGate(): TrustGate {
  return { stuckMs: 0, lastT: null, trusted: false };
}

/**
 * Accumulates time spent on the step's orientation hint (only while
 * `counting`, e.g. after the spoken instruction). Returns true on the frame
 * the gate flips to trusted.
 */
export function updateTrust(g: TrustGate, view: ViewName, hint: PoseHint | null, now: number, counting: boolean): boolean {
  const dt = g.lastT === null ? 0 : Math.min(MAX_DT_MS, Math.max(0, now - g.lastT));
  g.lastT = now;
  const target = orientationHintFor(view);
  if (g.trusted || !target || !counting || hint !== target) return false;
  g.stuckMs += dt;
  if (g.stuckMs < TRUST_ORIENTATION_MS) return false;
  g.trusted = true;
  return true;
}
